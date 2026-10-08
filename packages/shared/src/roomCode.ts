export const ROOM_CODE_LENGTH = 4;
/** No vowels (so codes never spell words) and nothing easily misheard or misread. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const normalizeRoomCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
