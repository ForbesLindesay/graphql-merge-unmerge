# graphql-merge-unmerge

A function to help you merge multiple graphql queries and then un-merge the result. This allows you to submit batched queries even if the backend does not support batch queries. e.g. for GitHub this could potentially save you from hitting their rate limit, by merging all your separate queries into one large query.

## Installation

```
yarn add graphql-merge-unmerge graphql graphql-tag
```

## Usage

### Simple

```ts
import {Batch} from 'graphql-merge-unmerge';
import gql from 'graphql-tag';
import {print} from 'graphql';

const batch = new Batch(async ({query, variables}) => {
  return await callGraphQLServer({query: print(query), variables});
});

const resultA = batch.queue({
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
});

const resultB = batch.queue({
  query: gql`
    query($id: Int!) {
      user(id: $id) {
        id
        name
      }
    }
  `,
  variables: {id: 3},
});

await batch.run();

console.log(await resultA);
console.log(await resultB);
```

This will run a single query that looks like:

```
{
  query: gql`
    query($id: Int!) {
      user(id: $id) {
        id
        name
        teams {
          name
        }
      }
    }
  `,
  variables: {id: 3},
}
```

and then split out the results for you.

### Advanced

```ts
import merge from 'graphql-merge-unmerge';
import gql from 'graphql-tag';
import {print} from 'graphql';

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
]);

const results = merged.unmergeAllQueries(
  await Promise.all(
    // Even after merging, there could still be multiple "documents"
    // representing the queries that need to be sent to the server.
    // For fairly simple queries, there will almost always just be one
    // query at the top level.
    merged.allQueries.map(({query, variables}) =>
      callGraphQLServer({query: print(query), variables}),
    ),
  ),
);
```
