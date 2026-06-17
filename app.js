/**
 * app.js  —  Grist Calendar (Custom Widget)
 * ─────────────────────────────────────────────────────────────────
 * Runs inside Grist as a Custom Widget.
 * Data is injected by the Grist plugin API — no fetch() calls,
 * no API key, no CORS issues.
 *
 * Required Grist setup:
 *   • Add widget to page, set data source to the Calendar table
 *   • Grant "Full document access" when Grist prompts
 *
 * Sections:
 *   1. Configuration  — table & column names only (no URLs/keys)
 *   2. State          — runtime variables
 *   3. Date helpers   — parsing, formatting, comparison
 *   4. Period helpers — classify event as Morning / Afternoon / All day
 *   5. Text helpers   — parse available names from calendar_text
 *   6. Navigation & Render
 *   7. Week view      — renderWeek, overlap layout algorithm
 *   8b. Autocomplete  — "Who are you?" field
 *   9. Modal          — openModal, closeModal, confirmEvent
 *  10. Grist Plugin API — fetchTable, write booking
 *  11. UI helpers     — showToast
 *  12. Bootstrap      — grist.ready(), loadData(), 5s refresh
 */


/* ═══════════════════════════════════════════════════════════════
   1. CONFIGURATION
   ─────────────────────────────────────────────────────────────
   Only table and column names live here.
   No API keys or URLs — the Grist plugin API handles all of that.
════════════════════════════════════════════════════════════════ */
const CONFIG = {
  /** Grist table IDs (case-sensitive, as shown in the Grist URL) */
  tables: {
    calendar: 'Calendar',                  // source: events to display
    people:   'People',                    // source: list of staff names
    bookings: 'Getting_available_place',   // target: booking records
  },

  /** Column IDs inside the Calendar table */
  calendarCols: {
    date:  'date',           // Date column  (dd/mm/yyyy string)
    text:  'calendar_text',  // Text column  ("N places:\nName1,\nName2")
    start: 'start',          // Start time   (Grist DateTime → Unix timestamp)
    end:   'end',            // End time     (Grist DateTime → Unix timestamp)
  },

  /** Column IDs inside the Getting_available_place table */
  bookingCols: {
    date:            'date',
    personAvailable: 'people_available_place',
    personTaking:    'people_taking_the_place',
    period:          'Period',
  },

  /** Visible hour range for the week view (inclusive start, exclusive end) */
  dayStart: 6,   // 06:00
  dayEnd:   20,  // 20:00

  /** Height in pixels of one hour row — must match --hour-height in CSS */
  hourHeight: 48,
};


/* ═══════════════════════════════════════════════════════════════
   2. STATE
   Runtime variables shared across rendering and modal functions.
════════════════════════════════════════════════════════════════ */
let currentView   = 'week';
let currentDate   = new Date();
let events        = [];   // normalised event objects (from Calendar table)
let people        = [];   // name strings (from People table)
let selectedEvent = null; // event currently shown in the modal


/* ═══════════════════════════════════════════════════════════════
   3. DATE HELPERS
════════════════════════════════════════════════════════════════ */

/** Short weekday names for the week-view header */
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Full month names for the period label */
const MONTHS_EN = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

/**
 * Parse a Grist date value into a JS Date.
 * Handles:
 *   - Unix timestamp (number, seconds)  → Grist Date/DateTime columns
 *   - "dd/mm/yyyy" string               → French locale date format
 *   - "yyyy-mm-dd" string               → ISO date format
 * @param {number|string|null} raw
 * @returns {Date|null}
 */
function parseEventDate(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') return new Date(raw * 1000);
  if (typeof raw === 'string') {
    const ddmmyyyy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyy) return new Date(+ddmmyyyy[3], +ddmmyyyy[2] - 1, +ddmmyyyy[1]);
    const yyyymmdd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (yyyymmdd) return new Date(+yyyymmdd[1], +yyyymmdd[2] - 1, +yyyymmdd[3]);
    return new Date(raw);
  }
  return null;
}

/**
 * Parse a Grist DateTime value into { h, m, str }.
 * Grist stores DateTime as a Unix timestamp (full date + time, seconds).
 * @param {number|string|null} raw
 * @returns {{ h: number, m: number, str: string }|null}
 */
function parseTime(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') {
    // Full Unix timestamp — extract local hours and minutes
    const d = new Date(raw * 1000);
    const h = d.getHours();
    const m = d.getMinutes();
    return { h, m, str: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
  }
  if (typeof raw === 'string') {
    const hm = raw.match(/(\d{1,2}):(\d{2})/);
    if (hm) {
      const h = +hm[1], m = +hm[2];
      return { h, m, str: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
    }
  }
  return null;
}

/** True if two Date objects fall on the same calendar day */
function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate()
  );
}

/** True if a Date is today */
function isToday(d) { return isSameDay(d, new Date()); }

/**
 * Return the Monday of the week containing d.
 * JS getDay() returns 0=Sun … 6=Sat; we map to 0=Mon … 6=Sun.
 */
function getWeekStart(d) {
  const day  = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
}

/**
 * Human-readable date string for the modal summary.
 * e.g. "Monday 16 June 2025"
 */
function fmtDate(d) {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

/** Filter global events[] to those falling on a given Date */
function getEventsForDay(d) {
  return events.filter(e => {
    const ed = parseEventDate(e._date);
    return ed && isSameDay(ed, d);
  });
}


/* ═══════════════════════════════════════════════════════════════
   4. PERIOD HELPERS
   Classify an event as Morning / Afternoon / All day based on
   its start and end times.
   Convention:
     All day   →  starts ≤ 08:00  AND  ends ≥ 17:00
     Morning   →  ends   ≤ 13:00
     Afternoon →  starts ≥ 12:00
════════════════════════════════════════════════════════════════ */

/**
 * @param {object} ev  normalised event object
 * @returns {'All day'|'Morning'|'Afternoon'}
 */
function getPeriod(ev) {
  const st = parseTime(ev._start);
  const en = parseTime(ev._end);
  if (!st) return 'All day';
  if (st.h <= 8 && en && en.h >= 17) return 'All day';
  if (en && en.h <= 13) return 'Morning';
  if (st.h >= 12) return 'Afternoon';
  return 'All day';
}

/** Shorthand: true when the event covers the whole working day */
function isAllDayEvent(ev) {
  return getPeriod(ev) === 'All day';
}


/* ═══════════════════════════════════════════════════════════════
   5. TEXT HELPERS — parse calendar_text
   The calendar_text field is produced by a Grist formula:

     entries = $available_place
     if len(entries) != 0:
       return f"{len(entries)} places:\n" + ",\n".join(entries)

   Example value:
     "3 places:\nAlice,\nBob,\nCarol"

   We want to extract ["Alice", "Bob", "Carol"].
════════════════════════════════════════════════════════════════ */

/**
 * Extract individual names from a calendar_text string.
 * Splits on newlines and commas, strips leading "N places:" header
 * and any entries that start with a digit.
 * @param {string} text
 * @returns {string[]}
 */
function parseAvailablePlaces(text) {
  if (!text) return [];
  const names = [];
  for (const chunk of text.split(/[\n,]+/)) {
    const name = chunk.trim().replace(/^-\s*/, '');
    // Skip the header line ("3 places:") and empty strings
    if (name && !/places?:/i.test(name) && !/^\d+/.test(name)) {
      names.push(name);
    }
  }
  return names;
}


/* ═══════════════════════════════════════════════════════════════
   6. NAVIGATION & RENDER
════════════════════════════════════════════════════════════════ */


/**
 * Move forward (+1) or backward (-1) by one week or one month.
 * @param {1|-1} dir
 */
/**
 * Move forward (+1) or backward (-1) by one week.
 * @param {1|-1} dir
 */
function navigate(dir) {
  currentDate = new Date(currentDate.getTime() + dir * 7 * 86400000);
  render();
}

/** Jump to the current week */
function goToday() {
  currentDate = new Date();
  render();
}

/** Render the calendar */
function render() {
  renderWeek();
}


/* ═══════════════════════════════════════════════════════════════
   7. WEEK VIEW
   ─────────────────────────────────────────────────────────────
   Layout:
     • A CSS grid provides the visual background (lines, labels).
     • A separate overlay grid (position:absolute) holds the actual
       event blocks so they can receive clicks without being blocked
       by the background cells.
     • Events are clipped to the visible hour window [dayStart, dayEnd].
     • Overlapping events in the same column are split side-by-side
       using a simple greedy algorithm.
════════════════════════════════════════════════════════════════ */

function renderWeek() {
  // Compute the Monday–Sunday span
  const ws = getWeekStart(currentDate);
  const we = new Date(ws.getTime() + 6 * 86400000);
  document.getElementById('period-label').textContent =
    `${ws.getDate()} ${MONTHS_EN[ws.getMonth()].slice(0,3)}. – ` +
    `${we.getDate()} ${MONTHS_EN[we.getMonth()].slice(0,3)}. ${we.getFullYear()}`;

  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(ws.getTime() + i * 86400000)
  );

  // ── Background grid ──────────────────────────────────────────
  let html = `<div class="week-wrapper"><div class="week-grid">`;

  // Header row
  html += `<div class="week-header-cell time-col"></div>`;
  days.forEach((d, i) => {
    const cls = isToday(d) ? ' today-col' : '';
    html += `<div class="week-header-cell${cls}">
      <span>${DAYS_EN[i]}</span>
      <span class="day-num">${d.getDate()}</span>
    </div>`;
  });

  // Hour rows — only the visible window [dayStart … dayEnd)
  for (let h = CONFIG.dayStart; h < CONFIG.dayEnd; h++) {
    const label = String(h).padStart(2, '0') + 'h';
    html += `<div class="time-col"><div class="time-slot">${label}</div></div>`;
    days.forEach(d => {
      const cls = isToday(d) ? ' today-col' : '';
      html += `<div class="day-col${cls}"><div class="hour-row"></div></div>`;
    });
  }
  html += `</div>`; // end .week-grid

  // ── Events overlay ───────────────────────────────────────────
  // One spacer + one event container per day column.
  // The spacer height is corrected by JS once the header has rendered.
  html += `<div class="week-events-layer">`;
  html += `<div style="width:${CONFIG.hourHeight}px"><div class="week-events-layer-spacer"></div></div>`;
  days.forEach((_, i) => {
    html += `<div>
      <div class="week-events-layer-spacer"></div>
      <div class="week-day-events" data-dayidx="${i}"></div>
    </div>`;
  });
  html += `</div></div>`; // end overlay + wrapper

  document.getElementById('calendar').innerHTML = html;

  // Align overlay spacers to the actual rendered header height
  requestAnimationFrame(() => {
    const headerCell = document.querySelector('.week-header-cell');
    if (headerCell) {
      const h = headerCell.offsetHeight;
      document.querySelectorAll('.week-events-layer-spacer')
        .forEach(el => el.style.height = h + 'px');
    }
  });

  // ── Place event blocks ───────────────────────────────────────
  /**
   * Two events overlap when their vertical spans intersect.
   * @param {{ top:number, height:number }} a
   * @param {{ top:number, height:number }} b
   */
  function overlaps(a, b) {
    return a.top < b.top + b.height && b.top < a.top + a.height;
  }

  days.forEach((day, dayIdx) => {
    const container = document.querySelector(
      `.week-day-events[data-dayidx="${dayIdx}"]`
    );
    if (!container) return;

    // Collect events for this day that have a parseable start time
    const dayEvs = events
      .map((ev, i) => ({ ev, i }))
      .filter(({ ev }) => {
        const ed = parseEventDate(ev._date);
        return ed && isSameDay(ed, day);
      });
    if (!dayEvs.length) return;

    // Build layout objects — positions in pixels relative to dayStart
    const parsed = dayEvs.map(({ ev, i }) => {
      const st = parseTime(ev._start);
      const en = parseTime(ev._end);
      if (!st) return null;

      // Clamp to the visible window so events don't overflow the grid
      const clampedStart = Math.max(st.h + st.m / 60, CONFIG.dayStart);
      const clampedEnd   = en
        ? Math.min(en.h + en.m / 60, CONFIG.dayEnd)
        : Math.min(st.h + 1 + st.m / 60, CONFIG.dayEnd);

      const top    = (clampedStart - CONFIG.dayStart) * CONFIG.hourHeight;
      const height = Math.max((clampedEnd - clampedStart) * CONFIG.hourHeight, 20);
      return { ev, i, st, en, top, height, _col: 0, _totalCols: 1 };
    }).filter(Boolean);

    // Greedy column assignment for overlapping events
    parsed.forEach((item, idx) => {
      const concurrent = parsed.filter((other, j) => j !== idx && overlaps(other, item));
      item._totalCols = concurrent.length + 1;
      item._col = 0;
      for (let c = 0; c < item._totalCols; c++) {
        if (!concurrent.some(o => o._col === c)) { item._col = c; break; }
      }
    });

    // Create DOM elements for each event block
    parsed.forEach(item => {
      const chip = document.createElement('div');
      chip.className = `week-event color-${item.i % 3}`;
      chip.style.position = 'absolute';
      chip.style.top      = item.top + 'px';
      chip.style.height   = item.height + 'px';
      chip.style.cursor   = 'pointer';

      const pct = 100 / item._totalCols;
      chip.style.left  = (item._col * pct) + '%';
      chip.style.width = `calc(${pct}% - 4px)`;

      chip.textContent = item.ev._text || '(no title)';
      chip.title = `${item.ev._text} — ${item.st.str}${item.en ? ' → ' + item.en.str : ''}`;

      chip.addEventListener('click', e => {
        e.stopPropagation(); // prevent modal-bg click handler from firing
        openModal(item.ev);
      });
      container.appendChild(chip);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   8b. AUTOCOMPLETE — "Who are you?" field
   ─────────────────────────────────────────────────────────────
   Replaces the native <select> with a text input + floating list.
   Features:
     • Filters on every keystroke, matching anywhere in the name
       (so "ar" matches "Marie", "Martin", "Bernard" etc.)
     • Highlights the matched portion in the suggestion
     • Keyboard navigation: ↑↓ to move, Enter to confirm, Escape to close
     • Clicking outside closes the list
     • Confirms selection into the hidden #modal-who-i-am input
════════════════════════════════════════════════════════════════ */

/**
 * Initialise (or reset) the autocomplete widget.
 * Called each time the modal opens so it starts clean.
 */
function initWhoAutocomplete() {
  const input     = document.getElementById('who-input');
  const list      = document.getElementById('who-list');
  const hiddenVal = document.getElementById('modal-who-i-am');

  // Clear previous state
  input.value = '';
  input.classList.remove('confirmed');
  hiddenVal.value = '';
  list.innerHTML  = '';
  list.classList.remove('open');

  let activeIdx = -1; // keyboard-highlighted index

  /**
   * Render the suggestion list for a given query string.
   * Matches anywhere in the name (case-insensitive).
   * @param {string} query
   */
  function showSuggestions(query) {
    list.innerHTML = '';
    activeIdx = -1;

    const q = query.trim().toLowerCase();
    // Show all names when input is empty, filtered list otherwise
    const matches = q === ''
      ? people
      : people.filter(p => p.toLowerCase().includes(q));

    if (matches.length === 0) {
      list.classList.remove('open');
      return;
    }

    matches.forEach(name => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');

      // Highlight the matched portion in bold blue
      if (q) {
        const matchStart = name.toLowerCase().indexOf(q);
        const before  = name.slice(0, matchStart);
        const matched = name.slice(matchStart, matchStart + q.length);
        const after   = name.slice(matchStart + q.length);
        li.innerHTML  = `${before}<mark>${matched}</mark>${after}`;
      } else {
        li.textContent = name;
      }

      li.addEventListener('mousedown', e => {
        // mousedown fires before the input blur — preventDefault keeps list open
        e.preventDefault();
        confirmSelection(name);
      });
      list.appendChild(li);
    });

    list.classList.add('open');
  }

  /**
   * Confirm a name as the selected value.
   * Updates the visible input, the hidden value, and closes the list.
   * @param {string} name
   */
  function confirmSelection(name) {
    input.value     = name;
    hiddenVal.value = name;
    input.classList.add('confirmed');
    list.classList.remove('open');
    list.innerHTML  = '';
    activeIdx       = -1;
  }

  // ── Event listeners ───────────────────────────────────────────

  // Filter list on every keystroke
  input.addEventListener('input', () => {
    input.classList.remove('confirmed');
    hiddenVal.value = '';
    showSuggestions(input.value);
  });

  // Show full list when the field is focused (even if empty)
  input.addEventListener('focus', () => {
    showSuggestions(input.value);
  });

  // Close list when focus leaves the widget entirely
  input.addEventListener('blur', () => {
    // Delay so mousedown on a list item fires first
    setTimeout(() => {
      list.classList.remove('open');
      // If the typed text exactly matches a name, auto-confirm it
      const exact = people.find(
        p => p.toLowerCase() === input.value.trim().toLowerCase()
      );
      if (exact) confirmSelection(exact);
    }, 150);
  });

  // Keyboard navigation: ↑ ↓ Enter Escape
  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('li');
    if (!list.classList.contains('open') || items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) confirmSelection(items[activeIdx].textContent);
      return;
    } else if (e.key === 'Escape') {
      list.classList.remove('open');
      activeIdx = -1;
      return;
    }

    // Update the visual highlight
    items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0) items[activeIdx].scrollIntoView({ block: 'nearest' });
  });

  // Auto-focus disabled — user clicks the field manually when ready.
}


/* ═══════════════════════════════════════════════════════════════
   9. MODAL — booking flow
   ─────────────────────────────────────────────────────────────
   openModal(ev)   — populate and show the modal for a given event
   closeModal(e?)  — hide the modal (only if clicking the backdrop)
   confirmEvent()  — POST a booking record to Grist, then refresh
════════════════════════════════════════════════════════════════ */

/**
 * Open the booking modal for an event.
 * Populates:
 *   - date, hours, period in the summary row
 *   - "Who are you?" dropdown from the people[] array
 *   - "Which spot?" dropdown from calendar_text names
 *   - Period selector (only for all-day events)
 * @param {object} ev  normalised event object
 */
function openModal(ev) {
  selectedEvent = ev;
  const ed      = parseEventDate(ev._date);
  const st      = parseTime(ev._start);
  const en      = parseTime(ev._end);
  const period  = getPeriod(ev);
  const allDay  = isAllDayEvent(ev);

  // Summary
  document.getElementById('modal-title').textContent  = ev._text || '(no title)';
  document.getElementById('modal-date').textContent   = ed ? fmtDate(ed) : '—';
  document.getElementById('modal-hours').textContent  = st
    ? st.str + (en ? ' → ' + en.str : '')
    : '—';
  document.getElementById('modal-period').textContent = period;

  // "Who are you?" — reset and init the autocomplete widget
  initWhoAutocomplete();

  // "Which spot?" — names parsed from calendar_text
  const places      = parseAvailablePlaces(ev._text);
  const placeSelect = document.getElementById('modal-whose-place');
  placeSelect.innerHTML = '<option value="">— Select —</option>';
  places.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    placeSelect.appendChild(opt);
  });

  // Period selector — only shown for all-day events
  const periodRow    = document.getElementById('modal-period-row');
  const periodSelect = document.getElementById('modal-period-select');
  if (allDay) {
    periodRow.style.display = 'block';
    periodSelect.value = 'All day';
  } else {
    periodRow.style.display = 'none';
    periodSelect.value = period;
  }

  document.getElementById('modal-bg').classList.add('open');
}

/**
 * Close the modal.
 * When called from the backdrop onclick handler, only closes if the
 * click target is the backdrop itself (not the modal card).
 * @param {MouseEvent|undefined} e
 */
function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-bg')) {
    document.getElementById('modal-bg').classList.remove('open');
    selectedEvent = null;
  }
}

/**
 * Write a booking record to Grist via the plugin API, then close
 * the modal. The calendar refreshes automatically because Grist
 * will re-trigger onRecords() after any table change.
 */
async function confirmEvent() {
  if (!selectedEvent) return;

  const whoIAm     = document.getElementById('modal-who-i-am').value.trim();
  const whosePlace = document.getElementById('modal-whose-place').value;

  if (!whoIAm)     { showToast('Please select who you are', 'error'); return; }
  if (!whosePlace) { showToast('Please select a spot', 'error'); return; }

  const btn = document.getElementById('modal-confirm-btn');
  btn.classList.add('loading');
  btn.textContent = 'Saving…';

  const ed     = parseEventDate(selectedEvent._date);
  const period = document.getElementById('modal-period-select').value
               || getPeriod(selectedEvent);

  try {
    /**
     * grist.docApi.applyUserActions() sends a list of Grist "user actions".
     * The AddRecord action takes: [tableName, rowId, fields]
     * rowId = null means "insert new row".
     */
    await grist.docApi.applyUserActions([
      ['AddRecord', CONFIG.tables.bookings, null, {
        [CONFIG.bookingCols.date]:            ed ? ed.toISOString().slice(0, 10) : '',
        [CONFIG.bookingCols.personAvailable]: whosePlace,
        [CONFIG.bookingCols.personTaking]:    whoIAm,
        [CONFIG.bookingCols.period]:          period,
      }]
    ]);

    showToast('Spot booked!', 'success');
    document.getElementById('modal-bg').classList.remove('open');
    selectedEvent = null;

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }

  btn.classList.remove('loading');
  btn.textContent = 'Confirm';
}


/* ═══════════════════════════════════════════════════════════════
   10. GRIST PLUGIN API
   ─────────────────────────────────────────────────────────────
   All data flows through the Grist plugin API:
     • grist.docApi.fetchTable() — read Calendar and People tables
     • grist.docApi.applyUserActions() — write booking (in confirmEvent)
   No fetch(), no API key, no CORS issues.
════════════════════════════════════════════════════════════════ */

/**
 * Normalise a raw Grist records object (columnar format) into the
 * array of event objects the rest of the app expects.
 *
 * Grist onRecords delivers data in columnar format:
 *   { id: [1,2,3], fields: { date: [...], calendar_text: [...], ... } }
 * We transpose that into row objects.
 *
 * @param {object} data  Raw Grist table data
 * @returns {Array}      Normalised event array
 */
function normaliseRecords(data) {
  /**
   * Grist onRecords() can deliver data in two formats depending on
   * whether column mapping is used:
   *
   * A) With column mapping (columns declared in grist.ready):
   *    An array of row objects with mapped names as keys:
   *    [ { id: 1, date: '...', calendar_text: '...', start: ..., end: ... }, ... ]
   *
   * B) Without column mapping (or fetchTable):
   *    A columnar object:
   *    { id: [1,2,...], date: [...], calendar_text: [...], ... }
   *
   * We detect which format we received and normalise to row objects.
   */
  let rows;

  if (Array.isArray(data)) {
    // Format A — already an array of row objects
    rows = data;
  } else {
    // Format B — columnar object, transpose to row array
    const ids = data.id || [];
    rows = ids.map((id, i) => {
      const row = { id };
      for (const key of Object.keys(data)) {
        if (key !== 'id') row[key] = data[key][i];
      }
      return row;
    });
  }

  return rows.map(row => ({
    _id:    row.id,
    _date:  row[CONFIG.calendarCols.date]  ?? null,
    _text:  row[CONFIG.calendarCols.text]  ?? '',
    _start: row[CONFIG.calendarCols.start] ?? null,
    _end:   row[CONFIG.calendarCols.end]   ?? null,
  })).filter(e => e._text && e._text.trim() !== '');
}

/**
 * Fetch the People table once and populate the people[] array.
 * Uses docApi.fetchTable() which returns data in the same columnar
 * format as onRecords.
 */
async function fetchPeople() {
  try {
    const data = await grist.docApi.fetchTable(CONFIG.tables.people);
    // Pick the first non-manualSort string column as the name column
    const colKeys = Object.keys(data).filter(k => k !== 'manualSort' && k !== 'id');
    const nameCol = colKeys.find(k => (data[k] || []).some(v => typeof v === 'string' && v.trim()))
                 || colKeys[0];
    people = nameCol
      ? (data[nameCol] || []).map(v => String(v || '').trim()).filter(Boolean)
      : [];
  } catch (e) {
    document.getElementById('status-msg').textContent = '✗ Could not load People table';
  }
}


/* ═══════════════════════════════════════════════════════════════
   11. UI HELPERS
════════════════════════════════════════════════════════════════ */

/**
 * Show a brief toast notification.
 * @param {string} msg
 * @param {'success'|'error'|''} type
 */
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { t.className = 'toast'; }, 2800);
}


/* ═══════════════════════════════════════════════════════════════
   12. BOOTSTRAP
   ─────────────────────────────────────────────────────────────
   1. Render empty calendar so layout is visible immediately.
   2. Tell Grist the widget is ready with full document access.
   3. loadData() reads Calendar + People via fetchTable() directly
      — no column mapping needed, no onRecords() loop issues.
   4. Auto-refreshes every 5 seconds.
════════════════════════════════════════════════════════════════ */

// Show skeleton layout before data arrives
render();

// Tell Grist we are ready — full access needed to read/write tables
grist.ready({ requiredAccess: 'full' });

/**
 * Load Calendar and People data directly via fetchTable().
 * Called once on startup then every 5 seconds.
 * @param {boolean} silent  If true, skip the loading indicator.
 */
async function loadData(silent = false) {
  const status = document.getElementById('status-msg');
  if (!silent) status.textContent = 'Loading…';
  try {
    const [calData] = await Promise.all([
      grist.docApi.fetchTable(CONFIG.tables.calendar),
      fetchPeople(),
    ]);
    events = normaliseRecords(calData);
    const now = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    status.textContent = `✓ ${events.length} event(s) — updated ${now}`;
    render();
  } catch (err) {
    if (!silent) status.textContent = `✗ ${err.message}`;
  }
}

// Initial load then refresh every 5 seconds
loadData();
setInterval(() => loadData(true), 5000);