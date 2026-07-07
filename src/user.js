// Signed-in user, shared by the sidebar footer and the top bar.
// (No auth backend yet — swap this for a real session when one exists.)
export const USER = { name: 'Prena Lalwani', email: 'prena.lalwani@koderlabs.com' };
export const INITIALS = USER.name
  .split(' ')
  .map((w) => w[0])
  .join('')
  .slice(0, 2)
  .toUpperCase();
