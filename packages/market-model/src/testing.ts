// Shared test fixtures: the NYSE calendar for 2026 and 2027 exactly as published by NYSE
// (https://www.nyse.com/trade/hours-calendars, read 2026-11-11). Used by tests only.
import type { Calendar } from './calendar.js';

export const NYSE_CALENDAR_2026_2027: Calendar = {
  version: 1,
  timezone: 'America/New_York',
  regular: { open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  holidays: [
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-01-19', name: 'Martin Luther King, Jr. Day' },
    { date: '2026-02-16', name: "Washington's Birthday" },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-05-25', name: 'Memorial Day' },
    { date: '2026-06-19', name: 'Juneteenth National Independence Day' },
    { date: '2026-07-03', name: 'Independence Day (observed)' },
    { date: '2026-09-07', name: 'Labor Day' },
    { date: '2026-11-26', name: 'Thanksgiving Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2027-01-01', name: "New Year's Day" },
    { date: '2027-01-18', name: 'Martin Luther King, Jr. Day' },
    { date: '2027-02-15', name: "Washington's Birthday" },
    { date: '2027-03-26', name: 'Good Friday' },
    { date: '2027-05-31', name: 'Memorial Day' },
    { date: '2027-06-18', name: 'Juneteenth National Independence Day (observed)' },
    { date: '2027-07-05', name: 'Independence Day (observed)' },
    { date: '2027-09-06', name: 'Labor Day' },
    { date: '2027-11-25', name: 'Thanksgiving Day' },
    { date: '2027-12-24', name: 'Christmas Day (observed)' },
  ],
  earlyCloses: [
    { date: '2026-11-27', close: '13:00', name: 'Day after Thanksgiving' },
    { date: '2026-12-24', close: '13:00', name: 'Christmas Eve' },
    { date: '2027-11-26', close: '13:00', name: 'Day after Thanksgiving' },
  ],
  coverage: { from: '2026-01-01', to: '2027-12-31' },
};
