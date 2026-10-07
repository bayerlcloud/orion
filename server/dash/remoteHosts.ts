// Lista fixa das 3 VPS remotas monitoradas pelo Dash (ver docs/infra.json).

export const REMOTE_HOSTS: { label: string; ip: string }[] = [
  { label: 'c1', ip: '86.48.28.10' },
  { label: 'c2', ip: '212.47.70.170' },
  { label: 'hostinger', ip: '72.61.135.82' },
];
