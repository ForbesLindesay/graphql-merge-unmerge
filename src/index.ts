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
} from 'graphql';
import {generateAlphabeticNameFromNumber} from 'generate-alphabetic-name';

export class Batch {
  private _started = false;
  private readonly _queue: Query[] = [];
  private readonly _resolvers = new Map<
    Query,
    {resolve: (v: any) => void; reject: (e: any) => void}
  >();
  private readonly _run: (q: Query) => Promise<any>;
  constructor(run: (q: Query) => Promise<any>) {
    this._run = run;
  }
  public async queue({query, variables}: Query) {
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
  public async run() {
    if (this._started) {
      throw new Error('You cannot run the same batch multiple times');
    }
    this._started = true;
    const merged = merge(this._queue);
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
          .then((results) => {
            const unmerged = merged.unmergeMergedQueries!(results);
            for (let i = 0; i < unmerged.length; i++) {
              const res = this._resolvers.get(merged.mergedQueries[i])!;
              res.resolve(unmerged[i]);
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
}
export type Query = {query: DocumentNode; variables: any};
export default function merge(
  queries: Query[],
): {
  mergedQuery: Query | undefined;
  mergedQueries: Query[];
  unmergedQueries: Query[];
  allQueries: Query[];
  unmergeMergedQueries: ((result: any) => any[]) | undefined;
  unmergeAllQueries: (results: any[]) => any[];
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
    definition: {query: OperationDefinitionNode; variables: any};
  }[] = [];

  for (const q of queries) {
    if (
      q.query.definitions.length === 1 &&
      q.query.definitions[0].kind === 'OperationDefinition' &&
      q.query.definitions[0].operation === 'query' &&
      (!q.query.definitions[0].directives ||
        q.query.definitions[0].directives.length === 0) &&
      q.query.definitions[0].selectionSet.selections.every(
        (s) => s.kind === 'Field',
      )
    ) {
      definitions.push({
        query: q,
        definition: {query: q.query.definitions[0], variables: q.variables},
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
      definitions: [merged.query],
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
        const resultsMap = new Map<Query, any>();
        const unmerged = merged.unmerge(mergedResults);
        for (let i = 0; i < unmerged.length; i++) {
          resultsMap.set(definitions[i].query, unmerged[i]);
        }
        return mergedQueries.map((d) => resultsMap.get(d));
      }),
    unmergeAllQueries: merged
      ? ([mergedResults, ...otherResults]) => {
          const resultsMap = new Map<Query, any>();
          const unmerged = merged.unmerge(mergedResults);
          for (let i = 0; i < unmerged.length; i++) {
            resultsMap.set(definitions[i].query, unmerged[i]);
          }

          for (let i = 0; i < otherResults.length; i++) {
            resultsMap.set(unmergedQueries[i], otherResults[i]);
          }

          return queries.map((d) => resultsMap.get(d));
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
  values: any,
  def: VariableDefinitionNode,
  value: any,
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
  definitions: {query: OperationDefinitionNode; variables: any}[],
): {
  query: OperationDefinitionNode;
  variables: any;
  unmerge: (results: any) => any[];
} {
  const variableNames = uniqueNameSet();
  const variableDefinitions: VariableDefinitionNode[] = [];
  const variables: any = {};
  const selections: FieldNode[] = [];
  const extractResults: ((r: any) => any)[] = [];

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
    unmerge: (v) => extractResults.map((e) => e(v)),
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

function selectSelectionSet(
  value: any,
  set: SelectionSetNode | undefined,
): any {
  if (!set) return value;
  if (Array.isArray(value)) return value.map((v) => selectSelectionSet(v, set));
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
function selectByFieldMappings(
  value: any,
  set: {
    alias: string;
    output: string;
    mapResult?: ((v: any) => any) | undefined;
  }[],
): any {
  if (!set) return value;
  if (Array.isArray(value))
    return value.map((v) => selectByFieldMappings(v, set));
  if (!value) return value;
  const result: any = {};
  for (const mapping of set) {
    result[mapping.output] = mapping.mapResult
      ? mapping.mapResult(value[mapping.alias])
      : value[mapping.alias];
  }
  return result;
}
function mergeFields(existingFields: FieldNode[], newFields: FieldNode[]) {
  const aliasNames = uniqueNameSet(
    existingFields.map((e) => e.alias?.value || e.name.value),
  );
  const fieldMapppings: {
    alias: string;
    output: string;
    mapResult?: (v: any) => any;
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
      fieldMapppings.push({
        alias: aliasName,
        output: outputName,
        mapResult: unmergeable
          ? undefined
          : (v) => selectSelectionSet(v, newField.selectionSet),
      });
    } else {
      const existingSelectionSet =
        existingFields[existingFieldIndex].selectionSet;
      const newSelectionSet = newField.selectionSet;
      const newSelections =
        existingSelectionSet && existingSelectionSet.selections.slice();
      let mapResult: undefined | ((r: any) => any);
      if (newSelections && newSelectionSet) {
        mapResult = mergeFields(
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
      fieldMapppings.push({alias: aliasName, output: outputName, mapResult});
    }
  }
  return (r: any) => selectByFieldMappings(r, fieldMapppings);
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
