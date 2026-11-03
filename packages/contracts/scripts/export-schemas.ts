// Prints the JSON Schema for every client operation and event. A handbook
// reference build that publishes this output is planned.
import { z } from 'zod'
import {
  CapabilityMap,
  CindlEvent,
  clientOps,
  CONTRACTS_VERSION,
  LinkState,
} from '../src/index.ts'

const schema = (type: z.ZodType) =>
  z.toJSONSchema(type, { unrepresentable: 'any', io: 'input' })
const operations = Object.fromEntries(
  Object.entries(clientOps).map(([name, definition]) => [
    name,
    {
      summary: definition.summary,
      mutates: definition.mutates,
      capability: (definition as { capability?: string }).capability ?? null,
      args: schema(definition.args),
      result: z.toJSONSchema(definition.result, { unrepresentable: 'any' }),
    },
  ]),
)
process.stdout.write(
  JSON.stringify(
    {
      contractsVersion: CONTRACTS_VERSION,
      operations,
      event: z.toJSONSchema(CindlEvent, { unrepresentable: 'any' }),
      linkState: z.toJSONSchema(LinkState, { unrepresentable: 'any' }),
      capabilities: z.toJSONSchema(CapabilityMap, { unrepresentable: 'any' }),
    },
    null,
    2,
  ) + '\n',
)
