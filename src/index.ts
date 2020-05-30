import {
  DocumentNode,
  OperationDefinitionNode,
  VariableDefinitionNode,
  SelectionSetNode,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  ValueNode,
  ArgumentNode,
  NameNode,
  FragmentDefinitionNode,
} from 'graphql';
import {generateAlphabeticNameFromNumber} from 'generate-alphabetic-name';

declare const DataSymbol: unique symbol;
declare class DataClass {
  private _type: typeof DataSymbol;
}
type Data = undefined | ({[key: string]: any} & DataClass);
type Variables = any;
type FormattedError = {readonly path?: (string | number)[]};

interface GraphQLResponseInternal {
  data?: Data;
  errors?: readonly FormattedError[];
}

export interface GraphQLResponse {
  data?: any;
  errors?: readonly any[];
}
export class Batch {
  private _started = false;
  private readonly _queue: Query[] = [];
  private readonly _resolvers = new Map<
    Query,
    {resolve: (v: GraphQLResponse) => void; reject: (e: Error) => void}
  >();
  private readonly _run: (q: Query) => Promise<GraphQLResponseInternal>;
  constructor(run: (q: Query) => Promise<GraphQLResponse>) {
    this._run = run;
  }
  public async queue({query, variables}: Query): Promise<GraphQLResponse> {
    if (this._started) {
      throw new Error(
        'This batch has already started, please create a fresh batch',
      );
    }
    return await new Promise((resolve, reject) => {
      // we take a shallow clone because it is valid to run
      // the same query multiple times
      const q = {query, variables};
      this._queue.push(q);
      this._resolvers.set(q, {resolve, reject});
    });
  }
  private async _runAndReport(input: Query[], isSecondAttempt = false) {
    if (!input.length) return;
    const merged = merge(input);
    await Promise.all([
      ...merged.unmergedQueries.map(async (q) => {
        const res = this._resolvers.get(q)!;
        try {
          res.resolve(await this._run(q));
        } catch (ex) {
          res.reject(ex);
        }
      }),
      merged.mergedQuery &&
        this._run(merged.mergedQuery)
          .then(async (results) => {
            const unmerged = merged.unmergeMergedQueries!(results);
            if (
              results.errors &&
              results.errors.length &&
              !isSecondAttempt &&
              input.length > 1
            ) {
              const nextBatch: Query[] = [];

              const errored = unmerged.map((response, i) => {
                if (response.errors) {
                  return this._runAndReport([input[i]], true);
                } else {
                  nextBatch.push(input[i]);
                  return null;
                }
              });
              await Promise.all([errored, this._runAndReport(nextBatch, true)]);
            } else {
              for (let i = 0; i < unmerged.length; i++) {
                const res = this._resolvers.get(merged.mergedQueries[i])!;
                if (!unmerged[i].errors && results.errors) {
                  res.resolve({...unmerged[i], errors: results.errors});
                } else {
                  res.resolve(unmerged[i]);
                }
              }
            }
          })
          .catch((err) => {
            for (const q of merged.mergedQueries) {
              const res = this._resolvers.get(q)!;
              res.reject(err);
            }
          }),
    ]);
  }
  public async run() {
    if (this._started) {
      throw new Error('You cannot run the same batch multiple times');
    }
    this._started = true;
    await this._runAndReport(this._queue);
  }
}

export type Query = {query: DocumentNode; variables: Variables};

export default function merge(
  queries: Query[],
): {
  mergedQuery: Query | undefined;
  mergedQueries: Query[];
  unmergedQueries: Query[];
  allQueries: Query[];
  unmergeMergedQueries:
    | ((result: GraphQLResponse) => GraphQLResponse[])
    | undefined;
  unmergeAllQueries: (results: GraphQLResponse[]) => GraphQLResponse[];
} {
  if (queries.length === 1) {
    return {
      mergedQuery: undefined,
      mergedQueries: [],
      unmergeMergedQueries: undefined,

      unmergedQueries: queries,

      allQueries: queries,
      unmergeAllQueries: (v) => v,
    };
  }
  const mergedQueries: Query[] = [];
  const unmergedQueries: Query[] = [];
  const definitions: {
    query: Query;
    definition: {query: OperationDefinitionNode; variables: Variables};
  }[] = [];

  const fragments: FragmentDefinitionNode[] = [];
  const nextFragmentName = uniqueNameSet();
  const fragmentNames = new Map<FragmentDefinitionNode, string>();
  for (const q of queries) {
    const queryOps = q.query.definitions.filter(
      (d) => d.kind === 'OperationDefinition' && d.operation === 'query',
    );
    if (
      q.query.definitions.every(
        (d) =>
          ((d.kind === 'OperationDefinition' &&
            d.operation === 'query' &&
            d.selectionSet.selections.every((s) => s.kind === 'Field')) ||
            d.kind === 'FragmentDefinition') &&
          !d.directives?.length,
      ) &&
      queryOps.length === 1
    ) {
      const query = queryOps[0] as OperationDefinitionNode;
      const fragmentNameMapping = new Map<string, string>();
      for (const fragment of q.query.definitions.filter(
        (d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition',
      )) {
        const oldName = fragment.name.value;
        let newName = fragmentNames.get(fragment);
        if (!newName) {
          newName = nextFragmentName(oldName);
          fragmentNames.set(fragment, newName);
          fragments.push(
            oldName === newName
              ? fragment
              : {
                  ...fragment,
                  name: {...fragment.name, value: newName},
                },
          );
        }
        if (oldName !== newName) fragmentNameMapping.set(oldName, newName);
      }
      definitions.push({
        query: q,
        definition: {
          query: fragmentNameMapping.size
            ? {
                ...query,
                selectionSet: renameFragments(
                  query.selectionSet,
                  fragmentNameMapping,
                ),
              }
            : query,
          variables: q.variables,
        },
      });
      mergedQueries.push(q);
    } else {
      unmergedQueries.push(q);
    }
  }

  const merged = definitions.length
    ? mergeDefinitions(definitions.map((d) => d.definition))
    : undefined;

  const mergedQuery: Query | undefined = merged && {
    query: {
      kind: 'Document',
      definitions: [merged.query, ...fragments],
    },
    variables: merged.variables,
  };
  return {
    mergedQuery,
    mergedQueries,
    unmergedQueries,
    allQueries: mergedQuery
      ? [mergedQuery, ...unmergedQueries]
      : unmergedQueries,
    unmergeMergedQueries:
      merged &&
      ((mergedResults) => {
        const resultsMap = new Map<Query, GraphQLResponseInternal>();
        const unmergedData = merged.unmergeData(mergedResults.data);
        const unmergedErrors = merged.unmergeErrors(mergedResults.errors || []);
        for (let i = 0; i < definitions.length; i++) {
          resultsMap.set(definitions[i].query, {
            data: unmergedData[i],
            errors: unmergedErrors[i].length ? unmergedErrors[i] : undefined,
          });
        }
        return mergedQueries.map((d) => resultsMap.get(d)!);
      }),
    unmergeAllQueries: merged
      ? ([mergedResults, ...otherResults]) => {
          const resultsMap = new Map<Query, GraphQLResponseInternal>();
          const unmergedData = merged.unmergeData(mergedResults.data);
          const unmergedErrors = merged.unmergeErrors(
            mergedResults.errors || [],
          );
          for (let i = 0; i < definitions.length; i++) {
            resultsMap.set(definitions[i].query, {
              data: unmergedData[i],
              errors: unmergedErrors[i].length ? unmergedErrors[i] : undefined,
            });
          }

          for (let i = 0; i < otherResults.length; i++) {
            resultsMap.set(unmergedQueries[i], otherResults[i]);
          }

          return queries.map((d) => resultsMap.get(d)!);
        }
      : (v) => v,
  };
}

function uniqueNameSet(init?: string[]) {
  const usedNames = new Set<string>(init);
  let uniqueID = 1;
  return (suggestion?: string) => {
    let result = suggestion || generateAlphabeticNameFromNumber(uniqueID++);
    while (usedNames.has(result)) {
      result = generateAlphabeticNameFromNumber(uniqueID++);
    }
    usedNames.add(result);
    return result;
  };
}

function valueNodesAreEqual(
  a: ValueNode | undefined,
  b: ValueNode | undefined,
) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.kind === 'NullValue' && b.kind === 'NullValue') return true;
  if (
    (a.kind === 'BooleanValue' && b.kind === 'BooleanValue') ||
    (a.kind === 'FloatValue' && b.kind === 'FloatValue') ||
    (a.kind === 'IntValue' && b.kind === 'IntValue') ||
    (a.kind === 'StringValue' && b.kind === 'StringValue')
  ) {
    return a.value === b.value;
  }
  return false;
}
function findExistingVariable(
  defs: VariableDefinitionNode[],
  values: Variables,
  def: VariableDefinitionNode,
  value: Variables,
) {
  for (const d of defs) {
    if (
      valueNodesAreEqual(d.defaultValue, def.defaultValue) &&
      (!d.directives || d.directives.length === 0) &&
      (!def.directives || def.directives.length === 0) &&
      values[d.variable.name.value] === value
    ) {
      return d.variable.name.value;
    }
  }
  return undefined;
}

function mergeDefinitions(
  definitions: {query: OperationDefinitionNode; variables: Variables}[],
): {
  query: OperationDefinitionNode;
  variables: Variables;
  unmergeData: (results: Data) => Data[];
  unmergeErrors: (results: readonly FormattedError[]) => FormattedError[][];
} {
  const variableNames = uniqueNameSet();
  const variableDefinitions: VariableDefinitionNode[] = [];
  const variables: Variables = {};
  const selections: FieldNode[] = [];
  const extractResults: {
    extractData: (r: Data) => Data;
    errorPath: (path: (string | number)[]) => (string | number)[] | null;
  }[] = [];

  for (const {query, variables: localVariables} of definitions) {
    const variableMapping = new Map<string, string>();
    for (const vari of query.variableDefinitions || []) {
      const originalName = vari.variable.name.value;
      const existingVariable = findExistingVariable(
        variableDefinitions,
        variables,
        vari,
        localVariables[originalName],
      );
      const transformedName = existingVariable || variableNames(originalName);
      if (originalName !== transformedName) {
        variableMapping.set(originalName, transformedName);
      }
      if (!existingVariable) {
        variables[transformedName] = localVariables[originalName];
        variableDefinitions.push({
          ...vari,
          variable: {
            ...vari.variable,
            name: {...vari.variable.name, value: transformedName},
          },
        });
      }
    }
    extractResults.push(
      mergeFields(
        selections,
        renameVariables(query.selectionSet, variableMapping).selections.map(
          (s) => {
            if (s.kind !== 'Field') {
              throw new Error(
                'We can only merge simple fields at the top level',
              );
            }
            return s;
          },
        ),
      ),
    );
  }
  return {
    query: {
      kind: 'OperationDefinition',
      operation: 'query',
      variableDefinitions,
      selectionSet: {
        kind: 'SelectionSet',
        selections,
      },
    },
    variables,
    unmergeData: (data) => extractResults.map((e) => e.extractData(data)),
    unmergeErrors: (errors) => {
      return extractResults.map((e) => {
        const outputErrors: FormattedError[] = [];
        for (const error of errors) {
          if (error.path) {
            const path = e.errorPath(error.path);
            if (path) {
              outputErrors.push({...error, path});
            }
          } else {
            outputErrors.push(error);
          }
        }
        return outputErrors;
      });
    },
  };
}

function renameVariables(
  set: SelectionSetNode,
  variableMapping: Map<string, string>,
) {
  if (variableMapping.size === 0) return set;
  return {
    ...set,
    selections: set.selections.map((s):
      | FieldNode
      | FragmentSpreadNode
      | InlineFragmentNode => {
      switch (s.kind) {
        case 'Field':
          return {
            ...s,
            arguments:
              s.arguments &&
              s.arguments.map((a) => ({
                ...a,
                value:
                  a.value.kind === 'Variable'
                    ? {
                        ...a.value,
                        name: {
                          ...a.value.name,
                          value:
                            variableMapping.get(a.value.name.value) ||
                            a.value.name.value,
                        },
                      }
                    : a.value,
              })),
            selectionSet:
              s.selectionSet &&
              renameVariables(s.selectionSet, variableMapping),
          };
        case 'FragmentSpread':
          return s;
        case 'InlineFragment':
          return {
            ...s,
            selectionSet: renameVariables(s.selectionSet, variableMapping),
          };
      }
    }),
  };
}

function renameFragments(
  set: SelectionSetNode,
  fragmentNameMapping: Map<string, string>,
) {
  if (fragmentNameMapping.size === 0) return set;
  return {
    ...set,
    selections: set.selections.map((s):
      | FieldNode
      | FragmentSpreadNode
      | InlineFragmentNode => {
      switch (s.kind) {
        case 'Field':
          return {
            ...s,
            selectionSet:
              s.selectionSet &&
              renameFragments(s.selectionSet, fragmentNameMapping),
          };
        case 'FragmentSpread':
          const newName = fragmentNameMapping.get(s.name.value);
          if (!newName) return s;
          return {
            ...s,
            name: {...s.name, value: newName},
          };
        case 'InlineFragment':
          return {
            ...s,
            selectionSet: renameFragments(s.selectionSet, fragmentNameMapping),
          };
      }
    }),
  };
}

function selectSelectionSet(
  value: Data,
  set: SelectionSetNode | undefined,
): Data {
  if (!set) return value;
  if (Array.isArray(value)) {
    return value.map((v) => selectSelectionSet(v, set)) as any;
  }
  if (!value) return value;
  const result: any = {};
  for (const selection of set.selections) {
    if (selection.kind !== 'Field') {
      return value;
    }
    result[selection.alias?.value || selection.name.value] = selectSelectionSet(
      value[selection.alias?.value || selection.name.value],
      selection.selectionSet,
    );
  }
  return result;
}
function errorPathForSelectionSet(
  path: (string | number)[],
  set: SelectionSetNode | undefined,
): null | (string | number)[] {
  if (!set) return path;
  const keyIndex = path.findIndex((p) => typeof p === 'string');
  if (keyIndex === -1) {
    return path;
  }
  const key = path[keyIndex];
  for (const selection of set.selections) {
    if (selection.kind !== 'Field') {
      return path;
    }
    const name = selection.alias?.value || selection.name.value;
    if (key === name) {
      const childrenInput = path.slice(keyIndex + 1);
      if (errorPathForSelectionSet(childrenInput, selection.selectionSet)) {
        return path;
      } else {
        return null;
      }
    }
  }
  return null;
}
function selectByFieldMappings(
  value: Data,
  set: {
    alias: string;
    output: string;
    children?:
      | {
          extractData: (v: Data) => Data;
          errorPath: (v: (string | number)[]) => (string | number)[] | null;
        }
      | undefined;
  }[],
): Data {
  if (Array.isArray(value))
    return value.map((v) => selectByFieldMappings(v, set)) as any;
  if (!value) return value;
  const result: any = {};
  for (const mapping of set) {
    result[mapping.output] = mapping.children
      ? mapping.children.extractData(value[mapping.alias])
      : value[mapping.alias];
  }
  return result;
}
function mergeFields(existingFields: FieldNode[], newFields: FieldNode[]) {
  const aliasNames = uniqueNameSet(
    existingFields.map((e) => e.alias?.value || e.name.value),
  );
  const fieldMappings: {
    alias: string;
    output: string;
    children?: {
      extractData: (v: Data) => Data;
      errorPath: (v: (string | number)[]) => null | (string | number)[];
    };
  }[] = [];
  for (const newField of newFields) {
    const outputName = newField.alias?.value || newField.name.value;
    const queryName = newField.name.value;
    const existingFieldIndex = existingFields.findIndex((ef) =>
      fieldsCanBeMerged(ef, newField),
    );
    if (existingFieldIndex === -1) {
      const aliasName = aliasNames(outputName);
      const alias: NameNode | undefined =
        aliasName === queryName ? undefined : {kind: 'Name', value: aliasName};
      existingFields.push({
        ...newField,
        alias,
      });
      const unmergeable = newField.selectionSet?.selections.some(
        (s) => s.kind !== 'Field',
      );
      fieldMappings.push({
        alias: aliasName,
        output: outputName,
        children: unmergeable
          ? undefined
          : {
              extractData: (v) => selectSelectionSet(v, newField.selectionSet),
              errorPath: (p) =>
                errorPathForSelectionSet(p, newField.selectionSet),
            },
      });
    } else {
      const existingSelectionSet =
        existingFields[existingFieldIndex].selectionSet;
      const newSelectionSet = newField.selectionSet;
      const newSelections =
        existingSelectionSet && existingSelectionSet.selections.slice();
      let children:
        | undefined
        | {
            extractData: (v: Data) => Data;
            errorPath: (v: (string | number)[]) => null | (string | number)[];
          };
      if (newSelections && newSelectionSet) {
        children = mergeFields(
          newSelections as FieldNode[],
          newSelectionSet.selections as FieldNode[],
        );
      }
      existingFields[existingFieldIndex] = {
        ...existingFields[existingFieldIndex],
        selectionSet: existingSelectionSet &&
          newSelections && {
            ...existingSelectionSet,
            selections: newSelections,
          },
      };
      const aliasName =
        existingFields[existingFieldIndex].alias?.value ||
        existingFields[existingFieldIndex].name.value;
      fieldMappings.push({alias: aliasName, output: outputName, children});
    }
  }
  return {
    extractData: (data: Data): Data => {
      return selectByFieldMappings(data, fieldMappings);
    },
    errorPath: (path: (string | number)[]): null | (string | number)[] => {
      const keyIndex = path.findIndex((p) => typeof p === 'string');
      if (keyIndex === -1) {
        return path;
      }
      const key = path[keyIndex];
      for (const f of fieldMappings) {
        if (f.alias === key) {
          if (!f.children) {
            return f.output === f.alias
              ? path
              : [...path.slice(0, keyIndex), f.output];
          }
          const childrenInput = path.slice(keyIndex + 1);
          const childrenResult = f.children.errorPath(childrenInput);
          if (!childrenResult) return null;
          return f.output === f.alias && childrenInput === childrenResult
            ? path
            : [...path.slice(0, keyIndex), f.output, ...childrenResult];
        }
      }
      return null;
    },
  };
}

function fieldsCanBeMerged(a: FieldNode, b: FieldNode) {
  if (a.name.value !== b.name.value) return false;
  if (a.directives?.length || b.directives?.length) return false;
  if (!argumentsAreEqual(a.arguments, b.arguments)) return false;
  if (
    a.selectionSet?.selections.some((s) => s.kind !== 'Field') ||
    b.selectionSet?.selections.some((s) => s.kind !== 'Field')
  )
    return false;
  return true;
}

function argumentsAreEqual(
  a: undefined | readonly ArgumentNode[],
  b: undefined | readonly ArgumentNode[],
) {
  if (
    (a === undefined || a.length === 0) &&
    (b === undefined || b.length === 0)
  ) {
    return true;
  }
  if (a === undefined) return false;
  if (b === undefined) return false;
  if (a.length !== b.length) return false;

  return a.every((aa) => b.some((bb) => argumentEqual(aa, bb)));
}

function argumentEqual(a: ArgumentNode, b: ArgumentNode) {
  return (
    a.name.value === b.name.value &&
    ((a.value.kind === 'Variable' &&
      b.value.kind === 'Variable' &&
      a.value.name.value === b.value.name.value) ||
      valueNodesAreEqual(a.value, b.value))
  );
}
