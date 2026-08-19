const METHODS = ['log', 'info', 'warn', 'error', 'debug'];

export function installTimestampedConsole() {
  if (console.__feishuBotTimestamped) return;
  Object.defineProperty(console, '__feishuBotTimestamped', { value: true });
  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(`[${formatLocalTimestamp()}]`, ...args);
  }
}

export function formatLocalTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absoluteOffset / 60));
  const offsetRemainder = pad(absoluteOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + ` ${sign}${offsetHours}:${offsetRemainder}`;
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}
