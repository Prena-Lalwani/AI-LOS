export const kpis = [
  { label: 'Forecast Accuracy', value: '92.6%', delta: '+1.1% vs 30d', state: 'flow' },
  { label: 'Next 7d Orders', value: '9,240', delta: '+12% vs plan', state: 'flow' },
  { label: 'Peak Day', value: 'Thu', delta: '+34% volume', state: 'attention' },
  { label: 'Capacity Gap', value: '+2 trucks', delta: 'Thu–Fri window', state: 'attention' },
];

// Forecast vs actual. `actual` is null for future periods so the line stops.
export const dailyForecast = [
  { label: '1', forecast: 1180, actual: 1150 },
  { label: '2', forecast: 1220, actual: 1240 },
  { label: '3', forecast: 1260, actual: 1230 },
  { label: '4', forecast: 1350, actual: 1330 },
  { label: '5', forecast: 1420, actual: 1400 },
  { label: '6', forecast: 1310, actual: 1290 },
  { label: '7', forecast: 1090, actual: 1120 },
  { label: '8', forecast: 1210, actual: 1190 },
  { label: '9', forecast: 1290, actual: 1300 },
  { label: '10', forecast: 1360, actual: 1340 },
  { label: '11', forecast: 1440, actual: null },
  { label: '12', forecast: 1520, actual: null },
  { label: '13', forecast: 1380, actual: null },
  { label: '14', forecast: 1160, actual: null },
];

export const weeklyForecast = [
  { label: 'W1', forecast: 8200, actual: 8100 },
  { label: 'W2', forecast: 8600, actual: 8500 },
  { label: 'W3', forecast: 9100, actual: 9000 },
  { label: 'W4', forecast: 8800, actual: 8700 },
  { label: 'W5', forecast: 9400, actual: 9300 },
  { label: 'W6', forecast: 9900, actual: null },
  { label: 'W7', forecast: 10200, actual: null },
  { label: 'W8', forecast: 9600, actual: null },
];

export const capacityRows = [
  { date: 'Jul 04', fc: '1,350', cap: '1,420', util: '95%', status: 'Tight', state: 'attention' },
  { date: 'Jul 05', fc: '1,420', cap: '1,420', util: '100%', status: 'At Limit', state: 'critical' },
  { date: 'Jul 06', fc: '1,310', cap: '1,420', util: '92%', status: 'On Track', state: 'flow' },
  { date: 'Jul 07', fc: '1,090', cap: '1,420', util: '77%', status: 'On Track', state: 'flow' },
  { date: 'Jul 08', fc: '1,290', cap: '1,420', util: '91%', status: 'On Track', state: 'flow' },
  { date: 'Jul 09', fc: '1,520', cap: '1,420', util: '107%', status: 'Over', state: 'critical' },
];

export const recommendations = [
  { title: 'Add 2 shifts · Columbus (Thu)', impact: 'Covers +34% peak-window volume', state: 'attention' },
  { title: 'Reserve 6 trucks · Thu–Fri', impact: 'Closes projected +2 truck capacity gap', state: 'attention' },
  { title: 'Extend picking hours · WH3', impact: 'Reduces dwell risk on RT-40 loads', state: 'flow' },
];
