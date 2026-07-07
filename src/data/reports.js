export const moduleFilters = ['All Modules', 'Executive', 'Demand', 'Inventory', 'Dispatch', 'Fleet'];

export const reports = [
  { name: 'Weekly Executive Summary', module: 'Executive', type: 'Scheduled', sched: 'Mon 06:00', last: 'Jun 30', status: 'Ready', state: 'flow' },
  { name: 'Monthly Cost & Revenue', module: 'Executive', type: 'Scheduled', sched: '1st 07:00', last: 'Jul 01', status: 'Ready', state: 'flow' },
  { name: 'Demand Forecast Accuracy', module: 'Demand', type: 'Scheduled', sched: 'Daily 05:00', last: 'Jul 03', status: 'Ready', state: 'flow' },
  { name: 'Capacity vs Actuals', module: 'Demand', type: 'Custom', sched: '—', last: 'Jul 02', status: 'Ready', state: 'flow' },
  { name: 'Reorder & Stock-Out Log', module: 'Inventory', type: 'Scheduled', sched: 'Daily 04:00', last: 'Jul 03', status: 'Running', state: 'attention' },
  { name: 'Warehouse Utilization', module: 'Inventory', type: 'Custom', sched: '—', last: 'Jun 28', status: 'Ready', state: 'flow' },
  { name: 'Route & ETA Performance', module: 'Dispatch', type: 'Scheduled', sched: 'Daily 22:00', last: 'Jul 02', status: 'Ready', state: 'flow' },
  { name: 'Fuel Spend Analysis', module: 'Dispatch', type: 'Custom', sched: '—', last: 'Jul 01', status: 'Ready', state: 'flow' },
  { name: 'Predictive Maintenance', module: 'Fleet', type: 'Scheduled', sched: 'Weekly Sun', last: 'Jun 29', status: 'Ready', state: 'flow' },
  { name: 'Driver Performance', module: 'Fleet', type: 'Custom', sched: '—', last: 'Jun 27', status: 'Ready', state: 'flow' },
];

export const otTrend = [
  { label: 'W1', ot: 91 },
  { label: 'W2', ot: 93 },
  { label: 'W3', ot: 90 },
  { label: 'W4', ot: 94 },
  { label: 'W5', ot: 92 },
  { label: 'W6', ot: 95 },
  { label: 'W7', ot: 94 },
];

// Cost per mile by region; amber where over the $2.00 target.
export const costPerMile = [
  { label: 'NE', cpm: 2.1 },
  { label: 'MW', cpm: 1.98 },
  { label: 'SE', cpm: 1.86 },
  { label: 'MA', cpm: 1.92 },
  { label: 'GL', cpm: 2.05 },
];
