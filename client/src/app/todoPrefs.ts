/**
 * Client-side TODO view preferences: whether the special "Today" and "All" tabs appear. They're
 * app-level views (not Microsoft lists), so they live in localStorage and are read by both the TODO
 * screen (to show/hide the tabs) and Settings (to toggle them). Default on.
 */
const SHOW_TODAY = 'homehub.todo.showToday'
const SHOW_ALL = 'homehub.todo.showAll'

export const getShowToday = (): boolean => localStorage.getItem(SHOW_TODAY) !== 'false'
export const getShowAll = (): boolean => localStorage.getItem(SHOW_ALL) !== 'false'
export const setShowToday = (v: boolean): void => localStorage.setItem(SHOW_TODAY, String(v))
export const setShowAll = (v: boolean): void => localStorage.setItem(SHOW_ALL, String(v))
