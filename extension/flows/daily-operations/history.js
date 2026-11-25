export const dailyHistoryKey = "pagelens.dailyOperations.history.v1";
export const dailyStateKey = "pagelens.dailyOperations.state.v1";
export const dailyScheduleKey = "pagelens.dailyOperations.schedule.v1";
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export const dayInChina = (time = Date.now()) => dayFormatter.format(time);

export function shiftDay(day, offset) {
  return new Date(Date.parse(day + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
}

export function addSnapshot(history, snapshot) {
  const day = dayInChina(snapshot.at);
  const sameDay = history.filter(entry => dayInChina(entry.at) === day).slice(-7);
  const earlier = new Map(history.filter(entry => dayInChina(entry.at) < day &&
    dayInChina(entry.at) >= shiftDay(day, -7)).map(entry => [dayInChina(entry.at), entry]));
  return [...earlier.values(), ...sameDay, snapshot];
}

export function compareSnapshot(history, snapshot) {
  const day = dayInChina(snapshot.at);
  const yesterday = history.findLast(entry => dayInChina(entry.at) === shiftDay(day, -1));
  const previous = history.at(-1);
  const lastSeven = new Map(history.filter(entry => dayInChina(entry.at) >= shiftDay(day, -6))
    .map(entry => [dayInChina(entry.at), entry.records.length]));
  lastSeven.set(day, snapshot.records.length);
  const counts = base => base ? snapshot.records.length - base.records.length : null;
  const previousRecords = new Map(previous?.records.map(row => [row.id, row.fields]));
  const added = previous ? snapshot.records.filter(row => !previousRecords.has(row.id)).map(row => row.id) : [];
  const changed = previous ? snapshot.records.filter(row => previousRecords.has(row.id) &&
    JSON.stringify(previousRecords.get(row.id)) !== JSON.stringify(row.fields)).map(row => row.id) : [];
  return { added, changed, previousDelta: counts(previous), yesterdayDelta: counts(yesterday),
    trend: Array.from({ length: 7 }, (_, i) => { const date = shiftDay(day, i - 6); return [date, lastSeven.get(date) ?? null]; }) };
}
