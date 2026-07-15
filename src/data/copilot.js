export const initialMessages = [
  {
    role: 'ai',
    text: "Hi — I'm your AI Operations Copilot. Ask me anything across demand, inventory, dispatch, fleet or executive metrics. Pick a suggested prompt below or type your own question to get started.",
  },
];

export const suggestedPrompts = [
  'Why did on-time delivery drop yesterday?',
  'Which routes are over fuel budget?',
  'What should I reorder this week?',
  'Summarize fleet maintenance risk',
];

/** Deterministic mock reply — keyword routed. Replace with a real API later. */
export function aiReply(q) {
  const s = q.toLowerCase();
  if (s.includes('on-time') || s.includes('on time') || s.includes('late') || s.includes('delivery'))
    return {
      text: 'On-time delivery dipped to 88.4% in the Midwest yesterday, 5.8 points below target. Root cause analysis:',
      bullets: [
        'Dock congestion at Columbus (WH3) added ~42 min average dwell',
        '2 tractors down for unplanned maintenance on RT-40',
        'Weather delay on the I-70 corridor (07:00–10:00)',
      ],
    };
  if (s.includes('fuel') || s.includes('budget') || s.includes('cost'))
    return {
      text: '3 routes are tracking over fuel budget this week:',
      bullets: [
        'RT-40 corridor: +9% vs plan (~$1,410 over)',
        'RT-22 Northeast: +6% (~$780 over)',
        '2 optimized fuel stops recommended — projected $118/day savings',
      ],
    };
  if (s.includes('reorder') || s.includes('stock') || s.includes('inventory') || s.includes('sku'))
    return {
      text: '7 SKUs need action this week to avoid stock-out:',
      bullets: [
        'SKU-10482 — 2.1 days of cover left, reorder 400 units',
        'SKU-20915 — below safety stock, reorder 250 units',
        'Overstock detected on SKU-33120 (~$48K tied up)',
      ],
    };
  if (s.includes('maintenance') || s.includes('fleet') || s.includes('vehicle') || s.includes('truck'))
    return {
      text: 'Fleet maintenance risk — 9 units due, 2 high-risk:',
      bullets: [
        'TRK-088 — front brake pads, high risk, service by Jul 06',
        'TRK-142 — coolant system, medium risk, service by Jul 09',
        'Scheduling now avoids ~11 hrs projected unplanned downtime',
      ],
    };
  return {
    text: `Analyzing "${q}" across all modules. The network is currently flowing within target at 94.2% on-time. I can break this down by module, route, or facility — let me know which view you need.`,
    bullets: [],
  };
}
