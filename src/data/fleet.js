export const kpis = [
  { label: 'Fleet Health', value: '86', delta: '/ 100', state: 'flow' },
  { label: 'Avg Utilization', value: '87%', delta: '-3% vs 7d', state: 'attention' },
  { label: 'Units In Service', value: '148', delta: 'of 157', state: 'flow' },
  { label: 'Due Maintenance', value: '9', delta: '2 high-risk', state: 'attention' },
];

export const maintenance = [
  { veh: 'TRK-088', comp: 'Brake Pads · Front', risk: 'High', pdate: 'Jul 06', state: 'critical' },
  { veh: 'TRK-142', comp: 'Coolant System', risk: 'High', pdate: 'Jul 09', state: 'critical' },
  { veh: 'TRK-076', comp: 'Tire Tread · Rear L', risk: 'Medium', pdate: 'Jul 12', state: 'attention' },
  { veh: 'TRK-203', comp: 'Transmission Fluid', risk: 'Medium', pdate: 'Jul 15', state: 'attention' },
  { veh: 'TRK-114', comp: 'Air Filter', risk: 'Low', pdate: 'Jul 22', state: 'flow' },
  { veh: 'TRK-165', comp: 'Battery', risk: 'Low', pdate: 'Jul 26', state: 'flow' },
];

export const drivers = [
  { driver: 'M. Alvarez', safety: '96', ot: '95%', mpg: '7.2', trips: '214', state: 'flow' },
  { driver: 'A. Novak', safety: '94', ot: '96%', mpg: '7.0', trips: '198', state: 'flow' },
  { driver: 'D. Reyes', safety: '91', ot: '92%', mpg: '6.8', trips: '187', state: 'flow' },
  { driver: 'K. Osei', safety: '88', ot: '90%', mpg: '6.5', trips: '176', state: 'attention' },
  { driver: 'S. Okafor', safety: '82', ot: '86%', mpg: '6.1', trips: '165', state: 'attention' },
  { driver: 'J. Bianchi', safety: '79', ot: '84%', mpg: '5.9', trips: '152', state: 'attention' },
];

export const fuelWeeks = [
  { label: 'W1', mpg: 6.4 },
  { label: 'W2', mpg: 6.6 },
  { label: 'W3', mpg: 6.5 },
  { label: 'W4', mpg: 6.8 },
  { label: 'W5', mpg: 6.9 },
  { label: 'W6', mpg: 6.7 },
  { label: 'W7', mpg: 7.0 },
  { label: 'W8', mpg: 7.1 },
];

export const lifecycle = [
  { label: 'Avg fleet age', value: '4.2 yrs', state: 'neutral' },
  { label: 'Units due replacement', value: '6', state: 'attention' },
  { label: 'Warranty expiring · 90d', value: '11', state: 'attention' },
];
