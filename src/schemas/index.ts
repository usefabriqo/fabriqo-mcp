import { z } from 'zod';
import {
  AwareDatetime,
  BooleanInput,
  Cursor,
  DatabaseId,
  DateInput,
  DEFAULT_PAGE_SIZE,
  Decimal14x4,
  HorizonDays,
  IdempotencyKey,
  LeadTimeDays,
  NonNegativeDecimal8x4,
  NonNegativeDecimal14x4,
  PageLimit,
  PercentageDecimal8x4,
  PositiveDecimal14x4,
  strip,
  text,
} from './primitives.js';

export * from './primitives.js';

export const CatalogStatus = z.enum([
  'draft',
  'active',
  'paused',
  'discontinued',
]);
export const BarcodeSymbology = z.enum(['code128', 'ean13', 'upc', 'qr']);
export const ItemType = z.enum(['product', 'material']);
export const PurchaseOrderStatus = z.enum([
  'draft',
  'ordered',
  'partial_received',
  'received',
  'cancelled',
]);
export const SalesOrderStatus = z.enum([
  'draft',
  'open',
  'partially_fulfilled',
  'fulfilled',
  'cancelled',
]);
export const ProductionRunStatus = z.enum([
  'planned',
  'in_progress',
  'completed',
  'cancelled',
]);
export const PurchaseOverheadKind = z.enum(['shipping', 'customs', 'other']);
export const PurchaseOverheadAllocation = z.enum(['by_quantity', 'by_value']);

const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullable().prefault(null).meta({ default: null });
const patch = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const keyed = { idempotency_key: optional(IdempotencyKey) };
const pagination = {
  limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
    default: DEFAULT_PAGE_SIZE,
  }),
  cursor: optional(Cursor),
};

export const ToolInput = z.object({}).strict();
export const ToolResult = z
  .object({
    data: z.record(z.string(), z.unknown()),
    request_id: z.string().nullable().default(null).meta({ default: null }),
  })
  .strict();
export const MutationToolResult = ToolResult.extend({
  idempotency_key: z.string().nullable().default(null).meta({ default: null }),
  replayed: z.boolean().default(false).meta({ default: false }),
}).strict();
export type ToolResult = z.output<typeof ToolResult>;
export type MutationToolResult = z.output<typeof MutationToolResult>;

export const PaginationInput = z.object(pagination).strict();
export const ListProductsInput = z
  .object({ ...pagination, status: optional(CatalogStatus) })
  .strict();
export const GetProductInput = z.object({ product_id: DatabaseId }).strict();
export const ListMaterialsInput = z
  .object({ ...pagination, status: optional(CatalogStatus) })
  .strict();
export const GetMaterialInput = z.object({ material_id: DatabaseId }).strict();

export const CreateProductInput = z
  .object({
    name: text(200, 1),
    sku: text(100, 1),
    unit: text(30, 1),
    reorder_level: NonNegativeDecimal14x4.prefault('0').meta({ default: '0' }),
    status: CatalogStatus.prefault('draft'),
    ...keyed,
  })
  .strict();

function requirePatch(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  entity: string,
  fields: readonly string[],
  nonNullable = fields,
): void {
  const provided = fields.filter((field) => value[field] !== undefined);
  if (provided.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: `At least one ${entity.toLowerCase()} field must be provided.`,
    });
  }
  const nulls = provided
    .filter((field) => nonNullable.includes(field) && value[field] === null)
    .sort();
  if (nulls.length > 0)
    ctx.addIssue({
      code: 'custom',
      message: `${entity} fields cannot be null: ${nulls.join(', ')}.`,
    });
}

export const UpdateProductInput = z
  .object({
    product_id: DatabaseId,
    name: patch(text(200, 1)),
    unit: patch(text(30, 1)),
    reorder_level: patch(NonNegativeDecimal14x4),
    status: patch(CatalogStatus),
  })
  .strict()
  .superRefine((value, ctx) =>
    requirePatch(value, ctx, 'Product', [
      'name',
      'unit',
      'reorder_level',
      'status',
    ]),
  );

export const CreateMaterialInput = z
  .object({
    name: text(200, 1),
    sku: text(100, 1),
    unit: text(30, 1),
    reorder_level: NonNegativeDecimal14x4.prefault('0').meta({ default: '0' }),
    default_supplier_id: optional(DatabaseId),
    status: CatalogStatus.prefault('active'),
    ...keyed,
  })
  .strict();
export const UpdateMaterialInput = z
  .object({
    material_id: DatabaseId,
    name: patch(text(200, 1)),
    unit: patch(text(30, 1)),
    reorder_level: patch(NonNegativeDecimal14x4),
    default_supplier_id: patch(DatabaseId),
    status: patch(CatalogStatus),
  })
  .strict()
  .superRefine((value, ctx) =>
    requirePatch(
      value,
      ctx,
      'Material',
      ['name', 'unit', 'reorder_level', 'default_supplier_id', 'status'],
      ['name', 'unit', 'reorder_level', 'status'],
    ),
  );

export const ListLocationsInput = z.object(pagination).strict();
export const ListLotsInput = z
  .object({
    ...pagination,
    item_id: optional(DatabaseId),
    supplier_id: optional(DatabaseId),
  })
  .strict();
export const InventoryStockInput = z
  .object({
    item_type: ItemType,
    item_id: DatabaseId,
    location_id: optional(DatabaseId),
    lot_id: optional(DatabaseId),
  })
  .strict();
export const ListInventoryMovementsInput = z
  .object({
    ...pagination,
    item_id: optional(DatabaseId),
    location_id: optional(DatabaseId),
    lot_id: optional(DatabaseId),
    reason: optional(text(40)),
  })
  .strict();
export const SearchSuppliersInput = z
  .object({
    ...pagination,
    q: optional(text(200)),
    include_archived: BooleanInput.prefault(false).meta({ default: false }),
  })
  .strict();
export const GetSupplierInput = z.object({ supplier_id: DatabaseId }).strict();

function supplierText(max: number, min = 0) {
  // Empty optional supplier strings are intentional clears, including PATCH.
  return z
    .preprocess(
      (value: unknown) =>
        typeof value === 'string' ? strip(value) || null : value,
      text(max, min).nullable(),
    )
    .meta({
      anyOf: [
        { type: 'string', ...(min ? { minLength: min } : {}), maxLength: max },
        { type: 'null' },
      ],
    });
}
const emailValid = (value: string | null): boolean =>
  value === null ||
  (value.includes('@') && !value.startsWith('@') && !value.endsWith('@'));
const supplierFields = {
  email: supplierText(255).refine(emailValid, 'Email address is invalid.'),
  phone: supplierText(60),
  website: supplierText(255),
  vat_number: supplierText(64),
  address_line1: supplierText(255),
  address_city: supplierText(120),
  address_postal_code: supplierText(40),
  address_country: supplierText(2, 2).overwrite((value) =>
    value === null ? null : value.toUpperCase(),
  ),
  contact_info: supplierText(4000),
  lead_time_days: LeadTimeDays.nullable(),
  notes: supplierText(4000),
};
export const CreateSupplierInput = z
  .object({
    name: text(200, 1),
    email: supplierFields.email.prefault(null).meta({ default: null }),
    phone: supplierFields.phone.prefault(null).meta({ default: null }),
    website: supplierFields.website.prefault(null).meta({ default: null }),
    vat_number: supplierFields.vat_number
      .prefault(null)
      .meta({ default: null }),
    address_line1: supplierFields.address_line1
      .prefault(null)
      .meta({ default: null }),
    address_city: supplierFields.address_city
      .prefault(null)
      .meta({ default: null }),
    address_postal_code: supplierFields.address_postal_code
      .prefault(null)
      .meta({ default: null }),
    address_country: supplierFields.address_country
      .prefault(null)
      .meta({ default: null }),
    contact_info: supplierFields.contact_info
      .prefault(null)
      .meta({ default: null }),
    lead_time_days: supplierFields.lead_time_days
      .prefault(null)
      .meta({ default: null }),
    notes: supplierFields.notes.prefault(null).meta({ default: null }),
    ...keyed,
  })
  .strict();
export const UpdateSupplierInput = z
  .object({
    supplier_id: DatabaseId,
    name: patch(text(200, 1)),
    email: supplierFields.email.optional(),
    phone: supplierFields.phone.optional(),
    website: supplierFields.website.optional(),
    vat_number: supplierFields.vat_number.optional(),
    address_line1: supplierFields.address_line1.optional(),
    address_city: supplierFields.address_city.optional(),
    address_postal_code: supplierFields.address_postal_code.optional(),
    address_country: supplierFields.address_country.optional(),
    contact_info: supplierFields.contact_info.optional(),
    lead_time_days: supplierFields.lead_time_days.optional(),
    notes: supplierFields.notes.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requirePatch(
      value,
      ctx,
      'Supplier',
      ['name', ...Object.keys(supplierFields)],
      [],
    );
    if (value.name === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Supplier name cannot be null.',
      });
  });

export const CreateLocationInput = z
  .object({ name: text(120, 1), slug: optional(text(120, 1)), ...keyed })
  .strict();
export const UpdateLocationInput = z
  .object({ location_id: DatabaseId, name: patch(text(120, 1)) })
  .strict()
  .superRefine((value, ctx) => {
    if (value.name === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Location name must be provided.',
      });
    if (value.name === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Location name cannot be null.',
      });
  });
export const SetDefaultLocationInput = z
  .object({ location_id: DatabaseId })
  .strict();
export const CreateBarcodeInput = z
  .object({
    item_id: DatabaseId,
    code: text(120, 1),
    symbology: BarcodeSymbology.prefault('code128'),
    is_primary: BooleanInput.prefault(false).meta({ default: false }),
    ...keyed,
  })
  .strict();

export const ListPurchaseOrdersInput = z
  .object({
    ...pagination,
    q: optional(text(200)),
    status: optional(PurchaseOrderStatus),
    supplier_id: optional(DatabaseId),
  })
  .strict();
export const GetPurchaseOrderInput = z
  .object({
    purchase_order_id: DatabaseId,
    line_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    line_cursor: optional(Cursor),
    overhead_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    overhead_cursor: optional(Cursor),
    receipt_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    receipt_cursor: optional(Cursor),
  })
  .strict();
export const ListSalesOrdersInput = z
  .object({
    ...pagination,
    status: optional(SalesOrderStatus),
    customer_id: optional(DatabaseId),
    source: optional(text(32, 1)),
  })
  .strict();
export const GetSalesOrderInput = z
  .object({
    order_id: DatabaseId,
    line_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    line_cursor: optional(Cursor),
    fulfillment_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    fulfillment_cursor: optional(Cursor),
  })
  .strict();
export const GetBomInput = z
  .object({ ...pagination, product_id: DatabaseId })
  .strict();
export const AddBomComponentInput = z
  .object({
    product_id: DatabaseId,
    material_id: DatabaseId,
    quantity_per_unit: PositiveDecimal14x4,
    scrappage_factor: NonNegativeDecimal8x4.prefault('0').meta({
      default: '0',
    }),
    ...keyed,
  })
  .strict();
export const UpdateBomComponentInput = z
  .object({
    bom_component_id: DatabaseId,
    quantity_per_unit: patch(PositiveDecimal14x4),
    scrappage_factor: patch(NonNegativeDecimal8x4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.quantity_per_unit == null && value.scrappage_factor == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one BOM component field must be provided.',
      });
    }
  });
export const RemoveBomComponentInput = z
  .object({ bom_component_id: DatabaseId })
  .strict();
export const PreviewBomCostInput = z
  .object({
    product_id: DatabaseId,
    quantity: PositiveDecimal14x4.prefault('1').meta({ default: '1' }),
  })
  .strict();

export const ListProductionRunsInput = z
  .object({ ...pagination, status: optional(ProductionRunStatus) })
  .strict();
export const GetProductionRunInput = z
  .object({
    run_id: DatabaseId,
    receipt_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    receipt_cursor: optional(Cursor),
  })
  .strict();
export const ProductionRunIdInput = z.object({ run_id: DatabaseId }).strict();
export const ProductionForecastInput = z
  .object({
    ...pagination,
    horizon_days: HorizonDays.prefault(30).meta({ default: 30 }),
  })
  .strict();
export const TraceLotInput = z
  .object({
    lot_id: DatabaseId,
    movements_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    movements_cursor: optional(Cursor),
    production_links_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    production_links_cursor: optional(Cursor),
    order_links_limit: PageLimit.prefault(DEFAULT_PAGE_SIZE).meta({
      default: DEFAULT_PAGE_SIZE,
    }),
    order_links_cursor: optional(Cursor),
  })
  .strict();

export const PurchaseOrderLineInput = z
  .object({
    item_type: ItemType,
    material_id: optional(DatabaseId),
    product_id: optional(DatabaseId),
    description: optional(text(255)),
    sku: optional(text(100)),
    unit: optional(text(30)),
    qty_ordered: PositiveDecimal14x4,
    unit_cost: NonNegativeDecimal14x4,
    tax_rate: PercentageDecimal8x4.prefault('0').meta({ default: '0' }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const valid =
      value.item_type === 'material'
        ? value.material_id !== null && value.product_id === null
        : value.product_id !== null && value.material_id === null;
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one item ID matching item_type must be provided.',
      });
  });
export const PurchaseOrderOverheadInput = z
  .object({
    kind: PurchaseOverheadKind,
    description: text(160, 1),
    amount: NonNegativeDecimal14x4,
    allocation_method: PurchaseOverheadAllocation.prefault('by_quantity'),
  })
  .strict();
export const PurchaseOrderLines = z
  .array(PurchaseOrderLineInput)
  .min(1)
  .max(500);
export const PurchaseOrderOverheads = z
  .array(PurchaseOrderOverheadInput)
  .max(100);
export const CreatePurchaseOrderInput = z
  .object({
    supplier_id: DatabaseId,
    po_number: optional(text(40, 1)),
    ordered_at: optional(AwareDatetime),
    expected_at: optional(AwareDatetime),
    receive_location_id: optional(DatabaseId),
    notes: optional(text(4000)),
    currency: optional(text(3, 3).overwrite((value) => value.toUpperCase())),
    confirm_paused_items: BooleanInput.prefault(false).meta({ default: false }),
    lines: PurchaseOrderLines,
    // The public Python callable accepts null and normalizes it to an empty list.
    overheads: PurchaseOrderOverheads.nullable()
      .prefault(null)
      .meta({ default: null })
      .transform((value) => value ?? []),
    ...keyed,
  })
  .strict();
export const MarkPurchaseOrderOrderedInput = z
  .object({ purchase_order_id: DatabaseId })
  .strict();
export const PurchaseReceiveLineInput = z
  .object({ line_id: DatabaseId, qty: PositiveDecimal14x4 })
  .strict();
export const PurchaseReceiveLines = z
  .array(PurchaseReceiveLineInput)
  .min(1)
  .max(500);
export const ReceivePurchaseOrderInput = z
  .object({
    purchase_order_id: DatabaseId,
    received_at: optional(AwareDatetime),
    location_id: optional(DatabaseId),
    notes: optional(text(4000)),
    lines: PurchaseReceiveLines,
    ...keyed,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.lines.map((line) => line.line_id)).size !==
      value.lines.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Each purchase order line may be received only once per request.',
      });
    }
  });

export const SalesOrderLineInput = z
  .object({
    product_id: DatabaseId,
    qty: PositiveDecimal14x4,
    unit_price: NonNegativeDecimal14x4,
  })
  .strict();
export const SalesOrderLines = z.array(SalesOrderLineInput).min(1).max(500);
export const CreateSalesOrderInput = z
  .object({
    customer_name: text(200, 1),
    customer_email: optional(text(255)).refine(
      emailValid,
      'Email address is invalid.',
    ),
    delivery_name: optional(text(200)),
    delivery_company: optional(text(200)),
    delivery_address_line1: optional(text(255)),
    delivery_address_line2: optional(text(255)),
    delivery_city: optional(text(120)),
    delivery_postal_code: optional(text(40)),
    delivery_country: optional(text(120)),
    delivery_phone: optional(text(60)),
    discount_amount: NonNegativeDecimal14x4.prefault('0').meta({
      default: '0',
    }),
    shipping_amount: NonNegativeDecimal14x4.prefault('0').meta({
      default: '0',
    }),
    tax_rate: PercentageDecimal8x4.prefault('0').meta({ default: '0' }),
    due_date: optional(DateInput),
    order_date: DateInput,
    notes: optional(text(4000)),
    confirm_paused_products: BooleanInput.prefault(false).meta({
      default: false,
    }),
    lines: SalesOrderLines,
    ...keyed,
  })
  .strict();
export const SalesOrderFulfillLineInput = z
  .object({ order_line_id: DatabaseId, qty: PositiveDecimal14x4 })
  .strict();
export const SalesOrderFulfillLines = z
  .array(SalesOrderFulfillLineInput)
  .min(1)
  .max(500);
export const FulfillSalesOrderInput = z
  .object({
    order_id: DatabaseId,
    location_id: optional(DatabaseId),
    fulfilled_at: optional(AwareDatetime),
    notes: optional(text(4000)),
    lines: SalesOrderFulfillLines,
    ...keyed,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.lines.map((line) => line.order_line_id)).size !==
      value.lines.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each order line may be fulfilled only once per request.',
      });
    }
  });

export const CreateProductionRunInput = z
  .object({
    product_id: DatabaseId,
    quantity_planned: PositiveDecimal14x4,
    notes: optional(text(4000)),
    confirm_paused_product: BooleanInput.prefault(false).meta({
      default: false,
    }),
    ...keyed,
  })
  .strict();
export const RecordProductionReceiptInput = z
  .object({
    run_id: DatabaseId,
    produced_quantity: NonNegativeDecimal14x4.prefault('0').meta({
      default: '0',
    }),
    scrap_quantity: NonNegativeDecimal14x4.prefault('0').meta({ default: '0' }),
    location_id: optional(DatabaseId),
    notes: optional(text(4000)),
    confirm_paused_materials: BooleanInput.prefault(false).meta({
      default: false,
    }),
    ...keyed,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Number(value.produced_quantity) + Number(value.scrap_quantity) <= 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Produced quantity or scrap quantity must be greater than zero.',
      });
    }
  });
export const TransferInventoryInput = z
  .object({
    item_id: DatabaseId,
    from_location_id: DatabaseId,
    to_location_id: DatabaseId,
    quantity: PositiveDecimal14x4,
    lot_id: optional(DatabaseId),
    ...keyed,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from_location_id === value.to_location_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Source and destination locations must differ.',
      });
    }
  });
export const AdjustInventoryInput = z
  .object({
    item_id: DatabaseId,
    location_id: DatabaseId,
    lot_id: optional(DatabaseId),
    quantity_delta: Decimal14x4,
    unit_cost: optional(NonNegativeDecimal14x4),
    reason_note: optional(text(4000)),
    ...keyed,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Number(value.quantity_delta) === 0)
      ctx.addIssue({
        code: 'custom',
        message: 'Adjustment quantity cannot be zero.',
      });
  });

type WithoutNull<T> = T extends readonly (infer V)[]
  ? WithoutNull<V>[]
  : T extends object
    ? { [K in keyof T]: WithoutNull<Exclude<T[K], null>> }
    : T;

/** Exclude omitted values always, and null recursively for creates/queries only. */
function serialize(value: unknown, excludeNone: boolean): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) => serialize(item, excludeNone));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, item]) => item !== undefined && (!excludeNone || item !== null),
        )
        .map(([key, item]) => [key, serialize(item, excludeNone)]),
    );
  }
  return value;
}

export function jsonBody<
  T extends object,
  const K extends readonly (keyof T)[] = readonly [],
  N extends boolean = true,
>(
  model: T,
  options: { exclude?: K; excludeNone?: N } = {},
): N extends false ? Omit<T, K[number]> : WithoutNull<Omit<T, K[number]>> {
  const excluded = new Set<PropertyKey>(options.exclude ?? []);
  const selected = Object.fromEntries(
    Object.entries(model).filter(([key]) => !excluded.has(key)),
  );
  return serialize(selected, options.excludeNone ?? true) as N extends false
    ? Omit<T, K[number]>
    : WithoutNull<Omit<T, K[number]>>;
}

export function queryParams<
  T extends object,
  const K extends readonly (keyof T)[] = readonly [],
>(model: T, options: { exclude?: K } = {}): WithoutNull<Omit<T, K[number]>> {
  return jsonBody<T, K, true>(model, options);
}
