export const kpis = [
  { label: 'Active Routes', value: '42', delta: 'live', state: 'flow' },
  { label: 'Avg Load Factor', value: '88%', delta: '+2% vs 7d', state: 'flow' },
  { label: 'On-Time ETA', value: '94%', delta: '-1% vs 7d', state: 'attention' },
  { label: 'Rerouted Today', value: '6', delta: 'AI dynamic', state: 'attention' },
];

export const assignments = [
  { truck: 'TRK-114', driver: 'M. Alvarez', route: 'RT-40 · Columbus → Cincinnati', load: '92%', eta: '14:20', status: 'On Route', state: 'flow' },
  { truck: 'TRK-088', driver: 'D. Reyes', route: 'RT-22 · Harrisburg → Newark', load: '86%', eta: '15:05', status: 'On Route', state: 'flow' },
  { truck: 'TRK-142', driver: 'S. Okafor', route: 'RT-70 · Indianapolis → Columbus', load: '78%', eta: '16:40', status: 'Delayed', state: 'attention' },
  { truck: 'TRK-076', driver: 'J. Bianchi', route: 'RT-80 · Cleveland → Pittsburgh', load: '0%', eta: '—', status: 'Loading', state: 'attention' },
  { truck: 'TRK-203', driver: 'A. Novak', route: 'RT-95 · Newark → Boston', load: '94%', eta: '17:15', status: 'On Route', state: 'flow' },
  { truck: 'TRK-165', driver: 'R. Haddad', route: 'RT-71 · Columbus → Louisville', load: '0%', eta: '—', status: 'Idle', state: 'neutral' },
  { truck: 'TRK-119', driver: 'K. Osei', route: 'RT-76 · Pittsburgh → Philadelphia', load: '81%', eta: '18:00', status: 'Rerouted', state: 'attention' },
];

export const fuelStops = [
  { loc: 'Pilot #442 · I-70 MM 92', truck: 'TRK-114', save: '$38', when: 'in 40 mi' },
  { loc: "Love's #310 · I-80 MM 210", truck: 'TRK-203', save: '$29', when: 'in 65 mi' },
  { loc: 'TA #118 · I-71 MM 55', truck: 'TRK-142', save: '$44', when: 'in 22 mi' },
  { loc: 'Sheetz #77 · I-76 MM 130', truck: 'TRK-119', save: '$21', when: 'in 88 mi' },
];

// Abstract route-map network (placeholder for a real map integration).
export const routeNodes = [
  { x: 70, y: 60, label: 'CMH' },
  { x: 220, y: 40, label: 'CLE' },
  { x: 360, y: 90, label: 'PIT' },
  { x: 520, y: 55, label: 'EWR' },
  { x: 180, y: 150, label: 'CVG' },
  { x: 420, y: 170, label: 'PHL' },
];

export const routeLinks = [
  { a: 0, b: 1, alt: false },
  { a: 1, b: 2, alt: false },
  { a: 2, b: 3, alt: false },
  { a: 0, b: 4, alt: false },
  { a: 2, b: 5, alt: true },
  { a: 4, b: 2, alt: false },
];
