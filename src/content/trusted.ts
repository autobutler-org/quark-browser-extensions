// Whether the user, not the page, made an event. Its own module so tests, where jsdom can't make a trusted
// event, can stand in for it.
export const trusted = (event: Event): boolean => event.isTrusted;
