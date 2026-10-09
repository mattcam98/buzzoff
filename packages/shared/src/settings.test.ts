import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, publicOrigin } from './settings';

describe('settings', () => {
  it('reduces a public address to its origin and refuses anything else', () => {
    expect(publicOrigin(' https://Buzz.Example.com/ ')).toBe('https://buzz.example.com');
    expect(publicOrigin('http://192.168.1.50:3210')).toBe('http://192.168.1.50:3210');
    expect(publicOrigin('http://[fd00::1]:3210')).toBe('http://[fd00::1]:3210');
    for (const bad of ['buzz.example.com', 'ftp://buzz.example.com', 'javascript:alert(1)', 'https://buzz.example.com/join', 'https://a@b.example', 'https://buzz.example.com?x=1', '']) {
      expect(publicOrigin(bad)).toBeNull();
    }
  });

  it('fills in defaults, so a document saved by an older version still loads', () => {
    expect(AppSettingsSchema.parse({ roomTtlHours: 48 })).toEqual({
      publicUrl: null, defaultPresetId: null, roomTtlHours: 48, finishedTtlHours: 6, maxUploadMb: 25, sessionDays: 30, publicLeaderboard: false,
    });
  });
});
