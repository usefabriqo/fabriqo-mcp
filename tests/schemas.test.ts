import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schemas from '../src/schemas/index.js';

interface SchemaCase {
  name: string;
  schema: keyof typeof schemas;
  input: Record<string, unknown>;
  success: boolean;
  output?: unknown;
}
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/schema-contract.json', import.meta.url),
    'utf8',
  ),
) as {
  source: string;
  cases: SchemaCase[];
};
const schemaByName: Record<string, unknown> = schemas;

describe('MCP schema compatibility', () => {
  it.each(fixture.cases)('$name', (example) => {
    const schema = schemaByName[example.schema];
    expect(schema).toBeInstanceOf(z.ZodType);
    if (!(schema instanceof z.ZodType))
      throw new Error(`Unknown fixture schema ${example.schema}`);
    const result = schema.safeParse(example.input);
    expect(result.success).toBe(example.success);
    if (result.success) expect(result.data).toEqual(example.output);
  });
});

describe('MCP schema boundary and serialization', () => {
  const inputSchemas = Object.entries(schemas).filter(
    ([name, schema]) => name.endsWith('Input') && schema instanceof z.ZodObject,
  );

  it('every object input is strict, with no workspace selector', () => {
    expect(inputSchemas.length).toBeGreaterThan(40);
    for (const [name, schema] of inputSchemas) {
      if (!(schema instanceof z.ZodType)) throw new Error(name);
      const json = z.toJSONSchema(schema, { io: 'input' });
      expect(json.additionalProperties, name).toBe(false);
      expect(JSON.stringify(json), name).not.toMatch(/workspace_(id|slug)/);
    }
  });

  it('advertises bounded numeric and boolean fields while preserving Pydantic coercion', () => {
    const json = z.toJSONSchema(schemas.SearchSuppliersInput, { io: 'input' });
    expect(json.properties?.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 25,
    });
    expect(json.properties?.include_archived).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(
      schemas.SearchSuppliersInput.parse({
        limit: '25',
        include_archived: 'yes',
      }),
    ).toMatchObject({ limit: 25, include_archived: true });
    expect(
      schemas.SearchSuppliersInput.safeParse({ limit: null }).success,
    ).toBe(false);
  });

  it('keeps nested pagination independent with MCP page size defaults', () => {
    expect(
      schemas.GetPurchaseOrderInput.parse({
        purchase_order_id: 1,
        line_cursor: 'a',
        overhead_cursor: 'b',
        receipt_cursor: 'c',
      }),
    ).toEqual({
      purchase_order_id: 1,
      line_limit: 25,
      line_cursor: 'a',
      overhead_limit: 25,
      overhead_cursor: 'b',
      receipt_limit: 25,
      receipt_cursor: 'c',
    });
    expect(schemas.TraceLotInput.parse({ lot_id: 1 })).toEqual({
      lot_id: 1,
      movements_limit: 25,
      movements_cursor: null,
      production_links_limit: 25,
      production_links_cursor: null,
      order_links_limit: 25,
      order_links_cursor: null,
    });
  });

  it('excludes null recursively in creates and preserves explicit PATCH clears', () => {
    const material = schemas.UpdateMaterialInput.parse({
      material_id: 1,
      default_supplier_id: null,
    });
    expect(Object.hasOwn(material, 'name')).toBe(false);
    expect(
      schemas.jsonBody(material, {
        exclude: ['material_id'],
        excludeNone: false,
      }),
    ).toEqual({ default_supplier_id: null });
    const supplier = schemas.UpdateSupplierInput.parse({
      supplier_id: 1,
      email: ' ',
      notes: null,
    });
    expect(
      schemas.jsonBody(supplier, {
        exclude: ['supplier_id'],
        excludeNone: false,
      }),
    ).toEqual({ email: null, notes: null });
    const po = schemas.CreatePurchaseOrderInput.parse({
      supplier_id: 1,
      lines: [
        {
          item_type: 'material',
          material_id: 2,
          qty_ordered: '1.2000',
          unit_cost: '2',
        },
      ],
    });
    expect(schemas.jsonBody(po, { exclude: ['idempotency_key'] })).toEqual({
      supplier_id: 1,
      confirm_paused_items: false,
      lines: [
        {
          item_type: 'material',
          material_id: 2,
          qty_ordered: '1.2000',
          unit_cost: '2',
          tax_rate: '0',
        },
      ],
      overheads: [],
    });
  });

  it('the public purchase order callable accepts omitted or null overheads', () => {
    const body = {
      supplier_id: 1,
      lines: [
        {
          item_type: 'material',
          material_id: 2,
          qty_ordered: '1',
          unit_cost: '2',
        },
      ],
    };
    expect(schemas.CreatePurchaseOrderInput.parse(body).overheads).toEqual([]);
    expect(
      schemas.CreatePurchaseOrderInput.parse({ ...body, overheads: null })
        .overheads,
    ).toEqual([]);
  });

  it.each([
    [
      'purchase order',
      schemas.PurchaseOrderLines,
      {
        item_type: 'material',
        material_id: 1,
        qty_ordered: '1',
        unit_cost: '1',
      },
    ],
    [
      'purchase receipt',
      schemas.PurchaseReceiveLines,
      { line_id: 1, qty: '1' },
    ],
    [
      'sales order',
      schemas.SalesOrderLines,
      { product_id: 1, qty: '1', unit_price: '1' },
    ],
    [
      'sales fulfillment',
      schemas.SalesOrderFulfillLines,
      { order_line_id: 1, qty: '1' },
    ],
  ] as const)('bounds %s lines to 1–500', (_name, schema, line) => {
    expect(schema.safeParse([]).success).toBe(false);
    expect(
      schema.safeParse(Array.from({ length: 500 }, () => line)).success,
    ).toBe(true);
    expect(
      schema.safeParse(Array.from({ length: 501 }, () => line)).success,
    ).toBe(false);
  });

  it('bounds overheads to 100', () => {
    const overhead = { kind: 'shipping', description: 'Shipping', amount: '1' };
    expect(
      schemas.PurchaseOrderOverheads.safeParse(
        Array.from({ length: 100 }, () => overhead),
      ).success,
    ).toBe(true);
    expect(
      schemas.PurchaseOrderOverheads.safeParse(
        Array.from({ length: 101 }, () => overhead),
      ).success,
    ).toBe(false);
  });

  it('rejects non-finite decimals and avoids rounding decimal strings', () => {
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      'NaN',
      'Infinity',
      '-Infinity',
    ]) {
      expect(schemas.Decimal14x4.safeParse(value).success).toBe(false);
    }
    expect(schemas.Decimal14x4.parse('9999999999.9999')).toBe(
      '9999999999.9999',
    );
    expect(schemas.Decimal14x4.safeParse('9999999999.99991').success).toBe(
      false,
    );
    expect(schemas.Decimal14x4.parse('1.23000')).toBe('1.23000');
  });

  it('validates structured output without discarding nested public fields', () => {
    const data = {
      nested: { amount: '123.45', metadata: null },
      lines: [{ id: 1 }],
    };
    expect(schemas.ToolResult.parse({ data })).toEqual({
      data,
      request_id: null,
    });
    expect(
      schemas.MutationToolResult.parse({
        data,
        request_id: 'req',
        idempotency_key: 'mcp:v1:123',
      }),
    ).toEqual({
      data,
      request_id: 'req',
      idempotency_key: 'mcp:v1:123',
      replayed: false,
    });
    expect(schemas.ToolResult.safeParse({ data: [] }).success).toBe(false);
    expect(
      schemas.ToolResult.safeParse({ data: {}, replayed: true }).success,
    ).toBe(false);
    expect(
      schemas.MutationToolResult.safeParse({ data: {}, replayed: 'true' })
        .success,
    ).toBe(false);
    expect(z.toJSONSchema(schemas.ToolResult).properties?.data).toMatchObject({
      type: 'object',
    });
    expect(
      z.toJSONSchema(schemas.MutationToolResult).properties,
    ).toHaveProperty('replayed');
  });
});
