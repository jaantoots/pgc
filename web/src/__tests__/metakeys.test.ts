import { describe, expect, it } from 'vitest';
import { caseWord, metaKeyName } from '../metakeys';

const ev = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', keyCode: 0, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe('metaKeyName', () => {
  it('reads letters from the key code, not the typed character, on macOS', () => {
    expect(metaKeyName(ev({ key: '∫', code: 'KeyB', keyCode: 66 }), true)).toBe('b');
    expect(metaKeyName(ev({ key: 'ı', code: 'KeyB', keyCode: 66, shiftKey: true }), true)).toBe('Shift-b');
    expect(metaKeyName(ev({ key: '¯', code: 'Comma', keyCode: 188, shiftKey: true }), true)).toBe('<');
    expect(metaKeyName(ev({ key: '˘', code: 'Period', keyCode: 190, shiftKey: true }), true)).toBe('>');
  });
  it('uses the typed character elsewhere', () => {
    expect(metaKeyName(ev({ key: 'f', code: 'KeyF', keyCode: 70 }), false)).toBe('f');
    expect(metaKeyName(ev({ key: '<', code: 'IntlBackslash', keyCode: 226 }), false)).toBe('<');
  });
  it('handles Backspace and ignores other modifiers', () => {
    expect(metaKeyName(ev({ key: 'Backspace', keyCode: 8 }), true)).toBe('Backspace');
    expect(metaKeyName(ev({ key: 'b', keyCode: 66, altKey: false }), false)).toBeNull();
    expect(metaKeyName(ev({ key: 'b', keyCode: 66, ctrlKey: true }), false)).toBeNull();
    expect(metaKeyName(ev({ key: 'b', keyCode: 66, metaKey: true }), true)).toBeNull();
    expect(metaKeyName(ev({ key: 'ArrowLeft', keyCode: 37 }), true)).toBeNull();
  });
});

describe('caseWord', () => {
  it('changes the next word and reports where it ends', () => {
    expect(caseWord('select foo', 'upper')).toEqual({ from: 0, to: 6, insert: 'SELECT' });
    expect(caseWord('  FROM x', 'lower')).toEqual({ from: 2, to: 6, insert: 'from' });
    expect(caseWord('.öRDER_by', 'capitalize')).toEqual({ from: 1, to: 9, insert: 'Örder_by' });
    expect(caseWord(' ;  ', 'upper')).toBeNull();
  });
});
