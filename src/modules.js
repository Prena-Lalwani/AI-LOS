/**
 * Shared route + nav config. Icons are single-path monoline glyphs drawn with
 * currentColor so they recolor via CSS. Used by Sidebar and the module launcher.
 */
export const MODULES = [
  { path: '/', label: 'Executive Intelligence', short: 'Executive', desc: 'Live health, KPIs & AI summary', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { path: '/demand', label: 'Order & Demand', short: 'Demand', desc: 'Forecasts & capacity planning', icon: 'M4 4v16h16M8 14l3-3 3 2 4-5' },
  { path: '/inventory', label: 'Inventory & Warehouse', short: 'Inventory', desc: 'Reorder, stock-out & heatmap', icon: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8' },
  { path: '/dispatch', label: 'Dispatch Intelligence', short: 'Dispatch', desc: 'Assignment, routing & fuel', icon: 'M1 6h13v9H1zM14 9h4l3 3v3h-7zM4.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3M17.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3' },
  { path: '/fleet', label: 'Fleet Intelligence', short: 'Fleet', desc: 'Predictive maintenance & drivers', icon: 'M4.5 16a9 9 0 1115 0M12 12l3.5-2.5' },
  { path: '/copilot', label: 'AI Operations Copilot', short: 'Copilot', desc: 'Ask across all modules', icon: 'M4 5h16v10H9l-4 4z' },
  { path: '/reports', label: 'Reports & Analytics', short: 'Reports', desc: 'Scheduled & custom reports', icon: 'M7 3h8l3 3v15H7zM14 3v4h4M10 12h6M10 16h6' },
];
