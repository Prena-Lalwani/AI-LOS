export const kpis = [
  { label: 'On-Time Delivery', value: '94.2%', delta: '+1.4% vs 7d', state: 'flow' },
  { label: 'Active Shipments', value: '1,284', delta: '+62 vs 7d', state: 'flow' },
  { label: 'Fleet Utilization', value: '87%', delta: '-3% vs 7d', state: 'attention' },
  { label: 'Cost / Mile', value: '$1.92', delta: '+$0.07 vs 7d', state: 'attention' },
  { label: 'Revenue MTD', value: '$4.82M', delta: '+8.1% vs plan', state: 'flow' },
  { label: 'Open Exceptions', value: '23', delta: '+5 vs 7d', state: 'attention' },
];

export const health = {
  score: 82,
  threshold: 75,
  subScores: [
    { label: 'On-Time Reliability', val: 94, state: 'flow' },
    { label: 'Fleet Readiness', val: 87, state: 'flow' },
    { label: 'Cost Efficiency', val: 68, state: 'attention' },
  ],
};

export const summaryStats = [
  { label: 'Network Health', value: '82', suffix: ' /100', variant: 'flow' },
  { label: 'Projected On-Time · 24h', value: '95.5%', variant: 'flow' },
  { label: 'Exceptions to Clear', value: '23', variant: 'attention' },
];

// Revenue vs operating cost, last 12 months ($M)
export const revenueTrend = [
  { label: 'Jul', revenue: 3.2, cost: 2.6 },
  { label: 'Aug', revenue: 3.5, cost: 2.8 },
  { label: 'Sep', revenue: 3.4, cost: 2.7 },
  { label: 'Oct', revenue: 3.8, cost: 3.0 },
  { label: 'Nov', revenue: 4.0, cost: 3.1 },
  { label: 'Dec', revenue: 3.9, cost: 3.0 },
  { label: 'Jan', revenue: 4.2, cost: 3.2 },
  { label: 'Feb', revenue: 4.4, cost: 3.35 },
  { label: 'Mar', revenue: 4.3, cost: 3.3 },
  { label: 'Apr', revenue: 4.6, cost: 3.5 },
  { label: 'May', revenue: 4.7, cost: 3.55 },
  { label: 'Jun', revenue: 4.82, cost: 3.6 },
];

export const alerts = [
  { text: 'Carrier API timeout — 12 shipments not updating', time: '2m', severity: 'critical' },
  { text: 'Fuel variance +9% vs plan · I-40 corridor', time: '14m', severity: 'attention' },
  { text: 'Warehouse 3 nearing dock congestion threshold', time: '31m', severity: 'attention' },
  { text: 'Peak-hour staffing confirmed · all 6 hubs', time: '1h', severity: 'flow' },
];

export const recommendations = [
  { title: 'Rebalance 4 tractors: Midwest → Southeast', impact: '+2.1% projected on-time · Thu peak', state: 'flow' },
  { title: 'Pre-position SKU cluster A inventory', impact: 'Covers forecast +18% demand · Thu–Fri', state: 'flow' },
  { title: 'Schedule maintenance · 3 fleet units', impact: 'Avoids ~11 hrs unplanned downtime', state: 'attention' },
];
