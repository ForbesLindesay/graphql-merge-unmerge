import merge, {Batch} from '../';

import {ApolloServer, gql as gqls} from 'apollo-server';
import gql, {disableFragmentWarnings} from 'graphql-tag';
import {print} from 'graphql';

/**
 * We want to test that they don't break things
 */
disableFragmentWarnings();

// A schema is a collection of type definitions (hence "typeDefs")
// that together define the "shape" of queries that are executed against
// your data.
const typeDefs = gqls`
  union Result = User | Team

  type User {
    id: Int!
    name: String!
    teams: [Team!]!
  }

  type Team {
    id: Int!
    name: String!
    users: [User!]!
  }

  type Query {
    teams: [Team!]!
    users: [User!]!
    node(id: Int): Result
    user(id: Int): User
    team(id: Int): Team
  }
`;

const records = [
  {t: 'Team', id: 1, name: 'Team A'},
  {t: 'Team', id: 2, name: 'Team B'},
  {t: 'User', id: 3, name: 'User A'},
  {t: 'User', id: 4, name: 'User B'},
  {t: 'User', id: 5, name: 'User C'},
  {t: 'User', id: 6, name: 'User D'},
] as const;

const userTeams = [
  [1, 3],
  [1, 4],
  [2, 5],
  [2, 6],
] as const;

const resolvers = {
  Result: {
    __resolveType({t}: typeof records[number]) {
      return t;
    },
  },
  Query: {
    teams() {
      return records.filter(({t}) => t === 'Team');
    },
    users() {
      return records.filter(({t}) => t === 'User');
    },
    node(_: unknown, {id}: {id: number}) {
      return records.find((r) => r.id === id) || null;
    },
    user(_: unknown, {id}: {id: number}) {
      return records.find((r) => r.t === 'User' && r.id === id) || null;
    },
    team(_: unknown, {id}: {id: number}) {
      return records.find((r) => r.t === 'Team' && r.id === id) || null;
    },
  },
  User: {
    teams(r: typeof records[number]) {
      return userTeams
        .filter(([_, userId]) => userId === r.id)
        .map(([teamId]) => records.find((r) => r.id === teamId));
    },
  },
  Team: {
    users(r: typeof records[number]) {
      return userTeams
        .filter(([teamId, _]) => teamId === r.id)
        .map(([_, userId]) => records.find((r) => r.id === userId));
    },
  },
};

const server = new ApolloServer({
  typeDefs,
  resolvers,
});

test('merge unmerge', async () => {
  const merged = merge([
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            id
            teams {
              name
            }
          }
        }
      `,
      variables: {id: 3},
    },
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            id
            name
          }
        }
      `,
      variables: {id: 3},
    },
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            name
          }
        }
      `,
      variables: {id: 4},
    },
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            name
          }
        }
      `,
      variables: {id: 42},
    },
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            id
          }
        }
      `,
      variables: {id: 42},
    },
    {
      query: gql`
        query($id: Int!) {
          user(id: $id) {
            teams {
              name
            }
          }
        }
      `,
      variables: {id: 42},
    },
    {
      query: gql`
        query($id: Int!) {
          node(id: $id) {
            ... on User {
              name
              teams {
                name
              }
            }
          }
        }
      `,
      variables: {id: 4},
    },
    {
      query: gql`
        query($id: Int!) {
          node(id: $id) {
            ... on User {
              name
            }
          }
        }
      `,
      variables: {id: 4},
    },
  ]);
  expect(
    merged.allQueries.map(({query, variables}) => ({
      query: print(query),
      variables,
    })),
  ).toMatchInlineSnapshot(`
    Array [
      Object {
        "query": "query ($id: Int!, $b: Int!, $c: Int!) {
      user(id: $id) {
        id
        teams {
          name
        }
        name
      }
      b: user(id: $b) {
        name
      }
      c: user(id: $c) {
        name
        id
        teams {
          name
        }
      }
      node(id: $b) {
        ... on User {
          name
          teams {
            name
          }
        }
      }
      d: node(id: $b) {
        ... on User {
          name
        }
      }
    }
    ",
        "variables": Object {
          "b": 4,
          "c": 42,
          "id": 3,
        },
      },
    ]
  `);
  const results = merged.unmergeAllQueries(
    (
      await Promise.all(
        merged.allQueries.map(({query, variables}) =>
          server.executeOperation({query: print(query), variables}),
        ),
      )
    ).map((r) => {
      if (!r.data) {
        expect(r.errors).toBeFalsy();
      }
      return r.data;
    }),
  );
  expect(results).toMatchInlineSnapshot(`
    Array [
      Object {
        "user": Object {
          "id": 3,
          "teams": Array [
            Object {
              "name": "Team A",
            },
          ],
        },
      },
      Object {
        "user": Object {
          "id": 3,
          "name": "User A",
        },
      },
      Object {
        "user": Object {
          "name": "User B",
        },
      },
      Object {
        "user": null,
      },
      Object {
        "user": null,
      },
      Object {
        "user": null,
      },
      Object {
        "node": Object {
          "name": "User B",
          "teams": Array [
            Object {
              "name": "Team A",
            },
          ],
        },
      },
      Object {
        "node": Object {
          "name": "User B",
        },
      },
    ]
  `);
});

test('batch', async () => {
  const queries: any[] = [];
  const batch = new Batch(async ({query, variables}) => {
    const q = {
      query: print(query),
      variables,
    };
    queries.push(q);
    const result = await server.executeOperation(q);
    if (result.errors && result.errors.length) {
      throw new Error(JSON.stringify(result.errors));
    }
    return result.data;
  });
  const results = Promise.all([
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
              teams {
                name
              }
            }
          }
        `,
        variables: {id: 3},
      }),
    ).resolves.toMatchInlineSnapshot(`
      Object {
        "user": Object {
          "id": 3,
          "teams": Array [
            Object {
              "name": "Team A",
            },
          ],
        },
      }
    `),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
              name
            }
          }
        `,
        variables: {id: 3},
      }),
    ).resolves.toMatchInlineSnapshot(`
      Object {
        "user": Object {
          "id": 3,
          "name": "User A",
        },
      }
    `),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              name
            }
          }
        `,
        variables: {id: 4},
      }),
    ).resolves.toMatchInlineSnapshot(`
      Object {
        "user": Object {
          "name": "User B",
        },
      }
    `),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              name
            }
          }
        `,
        variables: {id: 42},
      }),
    ).resolves.toMatchInlineSnapshot(`
      Object {
        "user": null,
      }
    `),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
            }
          }
        `,
        variables: {id: 42},
      }),
    ).resolves.toMatchInlineSnapshot(`
      Object {
        "user": null,
      }
    `),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              teams {
                name
              }
            }
          }
        `,
        variables: {id: 42},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "user": null,
}
`),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            node(id: $id) {
              ... on User {
                name
                teams {
                  name
                }
              }
            }
          }
        `,
        variables: {id: 4},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "node": Object {
    "name": "User B",
    "teams": Array [
      Object {
        "name": "Team A",
      },
    ],
  },
}
`),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            node(id: $id) {
              ... on User {
                name
              }
            }
          }
        `,
        variables: {id: 4},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "node": Object {
    "name": "User B",
  },
}
`),
  ]);
  await Promise.all([batch.run(), results]);
  expect(queries).toMatchInlineSnapshot(`
Array [
  Object {
    "query": "query ($id: Int!, $b: Int!, $c: Int!) {
  user(id: $id) {
    id
    teams {
      name
    }
    name
  }
  b: user(id: $b) {
    name
  }
  c: user(id: $c) {
    name
    id
    teams {
      name
    }
  }
  node(id: $b) {
    ... on User {
      name
      teams {
        name
      }
    }
  }
  d: node(id: $b) {
    ... on User {
      name
    }
  }
}
",
    "variables": Object {
      "b": 4,
      "c": 42,
      "id": 3,
    },
  },
]
`);
});

test('batch fragments', async () => {
  const queries: any[] = [];
  const batch = new Batch(async ({query, variables}) => {
    const q = {
      query: print(query),
      variables,
    };
    queries.push(q);
    const result = await server.executeOperation(q);
    if (result.errors && result.errors.length) {
      throw new Error(JSON.stringify(result.errors));
    }
    return result.data;
  });

  const results = Promise.all([
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
              ...UserTeams
            }
          }

          fragment UserTeams on User {
            teams {
              name
            }
          }
        `,
        variables: {id: 3},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "user": Object {
    "id": 3,
    "teams": Array [
      Object {
        "name": "Team A",
      },
    ],
  },
}
`),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
              ...UserTeams
            }
          }

          fragment UserTeams on User {
            teams {
              name
            }
          }
        `,
        variables: {id: 4},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "user": Object {
    "id": 4,
    "teams": Array [
      Object {
        "name": "Team A",
      },
    ],
  },
}
`),
    expect(
      batch.queue({
        query: gql`
          query($id: Int!) {
            user(id: $id) {
              id
              ...UserTeams
            }
          }

          fragment UserTeams on User {
            teams {
              id
            }
          }
        `,
        variables: {id: 3},
      }),
    ).resolves.toMatchInlineSnapshot(`
Object {
  "user": Object {
    "id": 3,
    "teams": Array [
      Object {
        "id": 1,
      },
    ],
  },
}
`),
  ]);
  await Promise.all([batch.run(), results]);
  expect(queries).toMatchInlineSnapshot(`
Array [
  Object {
    "query": "query ($id: Int!, $b: Int!) {
  user(id: $id) {
    id
    ...UserTeams
  }
  b: user(id: $b) {
    id
    ...UserTeams
  }
  c: user(id: $id) {
    id
    ...b
  }
}

fragment UserTeams on User {
  teams {
    name
  }
}

fragment b on User {
  teams {
    id
  }
}
",
    "variables": Object {
      "b": 4,
      "id": 3,
    },
  },
]
`);
});
