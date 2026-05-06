// Regression test for the War Room "Start Meeting" failure UX.
//
// Bug: when WARROOM_ENABLED is false (or the Python server is not yet
// running), POST /api/warroom/start returns 4xx/5xx with an error string.
// The legacy front-end used to add that error as a single line in the
// transcript area, which is easy to miss — the user perceives the click
// as "nothing happens" because the button only flickers for ~200ms.
//
// Fix: surface failures as a prominent error banner above the
// Start Meeting button. This test pins the banner DOM + helper functions
// in the rendered HTML so the UX can't silently regress again.

import { describe, it, expect } from 'vitest';
import { getWarRoomHtml } from './warroom-html.js';

describe('War Room HTML — Start Meeting failure UX', () => {
  const html = getWarRoomHtml('test-token', 'chat-1', 7860);

  it('renders an error banner element above the Start Meeting button', () => {
    expect(html).toContain('id="meetingError"');
  });

  it('exposes a showMeetingError helper for click-time failure paths', () => {
    expect(html).toMatch(/function\s+showMeetingError\s*\(/);
  });

  it('exposes a hideMeetingError helper so retries can clear the banner', () => {
    expect(html).toMatch(/function\s+hideMeetingError\s*\(/);
  });

  it('clears the banner at the start of toggleMeeting so retries do not stack errors', () => {
    // toggleMeeting() must call hideMeetingError() before doing the
    // fetch, otherwise the user re-clicks Start Meeting and the old
    // error stays on screen even after a successful start.
    const toggleStart = html.indexOf('async function toggleMeeting()');
    expect(toggleStart).toBeGreaterThan(-1);
    const toggleSlice = html.slice(toggleStart, toggleStart + 600);
    expect(toggleSlice).toMatch(/hideMeetingError\s*\(/);
  });

  it('shows the banner when the start API returns an error payload', () => {
    // The data.error branch in toggleMeeting should call
    // showMeetingError so the user actually sees the reason.
    const dataErrorIdx = html.indexOf('if (data.error)');
    expect(dataErrorIdx).toBeGreaterThan(-1);
    const branch = html.slice(dataErrorIdx, dataErrorIdx + 400);
    expect(branch).toMatch(/showMeetingError\s*\(/);
  });

  it('shows the banner when the fetch/connection throws (catch path)', () => {
    // The catch block at the bottom of toggleMeeting handles network
    // errors and Pipecat client setup throws. Without a banner here,
    // a thrown exception used to surface only as a transcript line.
    const catchIdx = html.indexOf("console.error('[WarRoom] Connection failed:'");
    expect(catchIdx).toBeGreaterThan(-1);
    const branch = html.slice(catchIdx, catchIdx + 500);
    expect(branch).toMatch(/showMeetingError\s*\(/);
  });

  it('shows the banner when the connect timeout fires', () => {
    // After the silent retry window, if onConnected still hasn't
    // fired we hit the 20s safety timeout. That used to write only a
    // transcript line; the banner makes it actually noticeable.
    const timeoutIdx = html.indexOf("'Connection timed out. Check the server logs.'");
    expect(timeoutIdx).toBeGreaterThan(-1);
    // Look both before and after — showMeetingError may be called on
    // the line above or below the transcript entry.
    const branch = html.slice(Math.max(0, timeoutIdx - 200), timeoutIdx + 400);
    expect(branch).toMatch(/showMeetingError\s*\(/);
  });

  it('exposes a .meeting-error CSS rule that hides via the [hidden] attribute', () => {
    // Pin the CSS so a future edit can't accidentally drop the
    // visual treatment without a test failure.
    expect(html).toMatch(/\.meeting-error\s*\{/);
    expect(html).toMatch(/\.meeting-error\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});
