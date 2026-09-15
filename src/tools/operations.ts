import type { Fabriqo, IdempotentRequestOptions } from '@usefabriqo/sdk';
import type { z } from 'zod';
import { jsonBody, queryParams } from '../schemas/index.js';
import type { InvocationContext } from '../sdk/client-factory.js';
import type { ToolName } from './contract.js';
import type { toolSchemas } from './schemas.js';

export type ToolInput<N extends ToolName> = z.output<(typeof toolSchemas)[N]>;

export interface OperationContext extends InvocationContext {
  idempotencyKey?: string;
}

function keyedOptions(context: OperationContext): IdempotentRequestOptions {
  if (!context.idempotencyKey)
    throw new Error('Missing effective idempotency key.');
  return { idempotencyKey: context.idempotencyKey, signal: context.signal };
}

/** Every operation is checked against the installed SDK's public method types. */
export const operations: {
  [N in ToolName]: (
    client: Fabriqo,
    args: ToolInput<N>,
    context: OperationContext,
  ) => Promise<unknown>;
} = {
  get_workspace: (c, _a, o) => c.workspace.get({ signal: o.signal }),
  list_products: (c, a, o) =>
    c.products.list(queryParams(a), { signal: o.signal }),
  get_product: (c, a, o) => c.products.get(a.product_id, { signal: o.signal }),
  list_materials: (c, a, o) =>
    c.materials.list(queryParams(a), { signal: o.signal }),
  get_material: (c, a, o) =>
    c.materials.get(a.material_id, { signal: o.signal }),
  list_locations: (c, a, o) =>
    c.locations.list(queryParams(a), { signal: o.signal }),
  list_lots: (c, a, o) => c.lots.list(queryParams(a), { signal: o.signal }),
  get_inventory_stock: (c, a, o) =>
    a.item_type === 'product'
      ? c.products.stock.get(
          a.item_id,
          queryParams(a, { exclude: ['item_type', 'item_id'] }),
          { signal: o.signal },
        )
      : c.materials.stock.get(
          a.item_id,
          queryParams(a, { exclude: ['item_type', 'item_id'] }),
          { signal: o.signal },
        ),
  list_inventory_movements: (c, a, o) =>
    c.inventory.movements.list(queryParams(a), { signal: o.signal }),
  search_suppliers: (c, a, o) =>
    c.suppliers.list(queryParams(a), { signal: o.signal }),
  get_supplier: (c, a, o) =>
    c.suppliers.get(a.supplier_id, { signal: o.signal }),
  list_purchase_orders: (c, a, o) =>
    c.purchaseOrders.list(queryParams(a), { signal: o.signal }),
  get_purchase_order: (c, a, o) =>
    c.purchaseOrders.get(
      a.purchase_order_id,
      queryParams(a, { exclude: ['purchase_order_id'] }),
      { signal: o.signal },
    ),
  list_sales_orders: (c, a, o) =>
    c.salesOrders.list(queryParams(a), { signal: o.signal }),
  get_sales_order: (c, a, o) =>
    c.salesOrders.get(a.order_id, queryParams(a, { exclude: ['order_id'] }), {
      signal: o.signal,
    }),
  get_bom: (c, a, o) => c.bomLines.list(queryParams(a), { signal: o.signal }),
  preview_bom_cost: (c, a, o) =>
    c.bomLines.costPreview(queryParams(a), { signal: o.signal }),
  list_production_runs: (c, a, o) =>
    c.productionRuns.list(queryParams(a), { signal: o.signal }),
  get_production_run: (c, a, o) =>
    c.productionRuns.get(a.run_id, queryParams(a, { exclude: ['run_id'] }), {
      signal: o.signal,
    }),
  get_production_run_costing: (c, a, o) =>
    c.productionRuns.costing.get(a.run_id, { signal: o.signal }),
  get_production_forecast: (c, a, o) =>
    c.manufacturingReports.productionForecast.get(queryParams(a), {
      signal: o.signal,
    }),
  get_recall_readiness: (c, _a, o) =>
    c.manufacturingReports.recallReadiness.get({ signal: o.signal }),
  trace_lot: (c, a, o) =>
    c.traceability.lots.get(a.lot_id, queryParams(a, { exclude: ['lot_id'] }), {
      signal: o.signal,
    }),
  create_product: (c, a, o) =>
    c.products.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  update_product: (c, a, o) =>
    c.products.update(
      a.product_id,
      jsonBody(a, { exclude: ['product_id'], excludeNone: false }),
      { signal: o.signal },
    ),
  create_material: (c, a, o) =>
    c.materials.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  update_material: (c, a, o) =>
    c.materials.update(
      a.material_id,
      jsonBody(a, { exclude: ['material_id'], excludeNone: false }),
      { signal: o.signal },
    ),
  create_supplier: (c, a, o) =>
    c.suppliers.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  update_supplier: (c, a, o) =>
    c.suppliers.update(
      a.supplier_id,
      jsonBody(a, { exclude: ['supplier_id'], excludeNone: false }),
      { signal: o.signal },
    ),
  create_location: (c, a, o) =>
    c.locations.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  update_location: (c, a, o) =>
    c.locations.update(
      a.location_id,
      jsonBody(a, { exclude: ['location_id'], excludeNone: false }),
      { signal: o.signal },
    ),
  set_default_location: (c, a, o) =>
    c.locations.makeDefault(a.location_id, { signal: o.signal }),
  create_barcode: (c, a, o) =>
    c.barcodes.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  add_bom_component: (c, a, o) =>
    c.bomLines.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  update_bom_component: (c, a, o) =>
    c.bomLines.update(
      a.bom_component_id,
      jsonBody(a, { exclude: ['bom_component_id'], excludeNone: false }),
      { signal: o.signal },
    ),
  remove_bom_component: (c, a, o) =>
    c.bomLines.delete(a.bom_component_id, { signal: o.signal }),
  create_purchase_order: (c, a, o) =>
    c.purchaseOrders.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  mark_purchase_order_ordered: (c, a, o) =>
    c.purchaseOrders.markOrdered(a.purchase_order_id, { signal: o.signal }),
  receive_purchase_order: (c, a, o) =>
    c.purchaseOrders.receipts.create(
      a.purchase_order_id,
      jsonBody(a, { exclude: ['purchase_order_id', 'idempotency_key'] }),
      keyedOptions(o),
    ),
  create_sales_order: (c, a, o) =>
    c.salesOrders.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  fulfill_sales_order: (c, a, o) =>
    c.salesOrders.fulfillments.create(
      a.order_id,
      jsonBody(a, { exclude: ['order_id', 'idempotency_key'] }),
      keyedOptions(o),
    ),
  create_production_run: (c, a, o) =>
    c.productionRuns.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  record_production_receipt: (c, a, o) =>
    c.productionRuns.receipts.create(
      a.run_id,
      jsonBody(a, { exclude: ['run_id', 'idempotency_key'] }),
      keyedOptions(o),
    ),
  transfer_inventory: (c, a, o) =>
    c.inventory.transfers.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
  adjust_inventory: (c, a, o) =>
    c.inventory.adjustments.create(
      jsonBody(a, { exclude: ['idempotency_key'] }),
      keyedOptions(o),
    ),
};
