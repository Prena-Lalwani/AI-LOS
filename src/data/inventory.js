export const kpis = [
  { label: 'SKUs Tracked', value: '4,820', delta: '6 facilities', state: 'flow' },
  { label: 'Reorder Alerts', value: '34', delta: '+8 vs 7d', state: 'attention' },
  { label: 'Stock-Out Risk', value: '7', delta: 'within 5 days', state: 'attention' },
  { label: 'Overstock Value', value: '$312K', delta: '11 SKUs tied up', state: 'attention' },
];

export const reorderRows = [
  { sku: 'SKU-10482', name: 'Pallet Wrap 20"', onHand: '120', rop: '180', rec: '400', status: 'Reorder Now', state: 'critical' },
  { sku: 'SKU-20915', name: 'Thermal Labels 4x6', onHand: '95', rop: '150', rec: '250', status: 'Reorder Now', state: 'critical' },
  { sku: 'SKU-60338', name: 'Edge Protectors', onHand: '60', rop: '90', rec: '150', status: 'Reorder Now', state: 'critical' },
  { sku: 'SKU-40781', name: 'Stretch Film HD', onHand: '210', rop: '220', rec: '200', status: 'Below Safety', state: 'attention' },
  { sku: 'SKU-33120', name: 'Corrugated Box M', onHand: '1,240', rop: '300', rec: '0', status: 'Overstock', state: 'attention' },
  { sku: 'SKU-51002', name: 'Poly Mailers L', onHand: '480', rop: '350', rec: '0', status: 'Healthy', state: 'flow' },
];

// Warehouse congestion utilization (0–100) across an 8-column zone grid.
export const heatUtil = [
  38, 45, 52, 60, 48, 42, 35, 40,
  55, 62, 70, 78, 66, 58, 50, 44,
  68, 74, 86, 92, 84, 72, 60, 52,
  72, 80, 94, 97, 90, 76, 64, 55,
  50, 58, 66, 74, 68, 60, 52, 46,
];

// bucket -> css class (b1 idle … b4 congested)
export const heatBucket = (u) => (u > 90 ? 'b4' : u > 75 ? 'b3' : u > 55 ? 'b2' : 'b1');

export const stockoutList = [
  { sku: 'SKU-10482 · Pallet Wrap 20"', days: '2.1 days', state: 'critical' },
  { sku: 'SKU-60338 · Edge Protectors', days: '3.4 days', state: 'attention' },
  { sku: 'SKU-20915 · Thermal Labels', days: '4.0 days', state: 'attention' },
];

export const overstockList = [
  { sku: 'SKU-33120 · Corrugated Box M', val: '$48K excess' },
  { sku: 'SKU-72110 · Void Fill Kraft', val: '$31K excess' },
  { sku: 'SKU-88401 · Wooden Skids', val: '$22K excess' },
];
