/**
 * LevelUp Pickleball Club — Court booking modal
 *
 * Drop-in: add <script src="/js/court-booking.js" defer></script> to any page with a
 * "Book a Court" button. It finds links pointing at CourtReserve's public booking (and any
 * element carrying [data-book-court]) and opens this modal instead.
 *
 * Deliberately fails safe: the click handler is only attached after the modal is built, so if
 * this script errors or never loads, those buttons keep their original CourtReserve href and
 * booking still works — just without guest-fee handling.
 *
 * Courts are assigned by the Worker (2, 3, 4… then 1). Nobody picks their own court.
 */
(function () {
  'use strict';

  // Court booking lives in the golf sim Worker under a /court/* namespace — it already had
  // the CourtReserve creds, Stripe keys, Resend and holiday logic. Golf sim endpoints
  // (/availability, /checkout, /cancel) are untouched and unrelated to these.
  var WORKER = 'https://levelup-golfsim-booking.s-jackson.workers.dev/court';
  var STRIPE_PUBLISHABLE_KEY = 'pk_live_51Phz4uByPDcoX1D7ypZ6h0w4fJ4mi2g9yx8orNfHKl7Q4ItIjsb5m2lGbVWmbFg0wk5J2WYp1WTgZTRRNwuzOs0B00AssY70P3';
  var PHONE = '412-206-5755';

  // Display only — the Worker recomputes every total, so tampering here changes nothing.
  var VISITOR_PASS = 10;
  var RATES = { weekday: 25, weekend: 35 };
  var DURATIONS = ['1 Hour', '1.5 Hours', '2 Hours', '2.5 Hours', '3 Hours'];
  var DURATION_MINS = { '1 Hour': 60, '1.5 Hours': 90, '2 Hours': 120, '2.5 Hours': 150, '3 Hours': 180 };
  var OPEN_HOUR = 7, CLOSE_HOUR = 22; // 7am–10pm; mirrored in the Worker, which enforces it

  // Display-only mirror of the Worker's COURT_PROMOS. The Worker recomputes and re-validates
  // every total, so a code faked here changes nothing that gets charged.
  var PROMOS = {
    'eggwhite': { flatRental: 1, durations: ['1 Hour'], maxCourts: 1, label: '$1 test promo' },
    // Free first-visit court for a new guest. Zeroes the court AND the guest's own pass.
    // Display only — the Worker enforces the once-per-person email/phone check.
    'firstserve': { freeNewGuest: true, freeHours: 1, maxCourts: 1, guestOnly: true, startMin: 690, startMax: 1080, label: 'First visit — first hour free' },
  };

  var state = { date: '', time: '', duration: '1 Hour', courts: 1, guests: 0, payAtClub: false, busy: [], courtTotal: 0, promo: '', bookerType: '' };

  // Browser-side memory of "this person already claimed the free first-visit court" — a convenience
  // so we don't keep dangling the offer at them. NOT enforcement: the Worker's per-person ledger +
  // member check are the real gate. Resets if they clear their browser or use another device.
  var CLAIM_KEY = 'lpc_free_court_claimed';
  function freeClaimed() { try { return !!localStorage.getItem(CLAIM_KEY); } catch (e) { return false; } }
  function markFreeClaimed() { try { localStorage.setItem(CLAIM_KEY, new Date().toISOString()); } catch (e) {} }
  function hideFreeOffer() {
    // Hide the homepage teaser banner(s) and, if the modal is built, its in-modal callout.
    Array.prototype.forEach.call(document.querySelectorAll('.cb-teaser'), function (t) { t.style.display = 'none'; });
    var fv = el('cbFirstVisit'); if (fv) fv.style.display = 'none';
  }
  var stripe = null, embedded = null, root = null, pausedMedia = [];

  // ---------- helpers ----------
  function isWeekendRate(dateStr) {
    var day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    return day === 0 || day === 5 || day === 6; // Fri, Sat, Sun
  }
  function hourlyFor(dateStr) { return isWeekendRate(dateStr) ? RATES.weekend : RATES.weekday; }
  function money(n) { return '$' + n.toFixed(2); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function el(id) { return root.querySelector('#' + id); }

  function timeSlots() {
    var out = [];
    for (var h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
      for (var m = 0; m < 60; m += 30) {
        var ampm = h >= 12 ? 'PM' : 'AM', hh = h % 12 || 12;
        out.push(hh + ':' + String(m).padStart(2, '0') + ' ' + ampm);
      }
    }
    return out;
  }

  function to24(t) {
    var parts = t.split(' '), hm = parts[0].split(':');
    var h = parseInt(hm[0]), m = parseInt(hm[1]);
    if (parts[1] === 'PM' && h !== 12) h += 12;
    if (parts[1] === 'AM' && h === 12) h = 0;
    return [h, m];
  }

  /**
   * CourtReserve times arrive as naive wall clock ("2026-07-22T18:00:00", no zone).
   * Date.parse() would read those as BROWSER-local while the slot boundaries below are built
   * as UTC — a 4-hour skew in Eastern, which made fully-booked evenings look wide open.
   * Parse both sides the same deliberate way instead. Mirrors parseClubTime() in the Worker.
   */
  function clubTime(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }

  /** Courts free for the whole requested window, using the same overlap rule as the Worker. */
  function freeCourtsAt(timeStr) {
    var hm = to24(timeStr);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var start = clubTime(state.date + 'T' + pad(hm[0]) + ':' + pad(hm[1]) + ':00');
    var end = start + DURATION_MINS[state.duration] * 60000;
    if (end > clubTime(state.date + 'T' + pad(CLOSE_HOUR) + ':00:00')) return 0;
    var taken = {};
    state.busy.forEach(function (b) {
      var bs = clubTime(b.start), be = clubTime(b.end);
      if (!isFinite(bs) || !isFinite(be)) return;
      if (start < be && bs < end) (b.courtIds || []).forEach(function (id) { taken[id] = 1; });
    });
    return Math.max(0, state.courtTotal - Object.keys(taken).length);
  }

  function isPast(timeStr) {
    if (state.date !== todayStr()) return false;
    var hm = to24(timeStr);
    var d = new Date(); d.setHours(hm[0], hm[1], 0, 0);
    return d.getTime() < Date.now();
  }

  // The promo currently valid for the chosen options (duration/courts/booker). null if none.
  function activePromo() {
    var promo = PROMOS[(state.promo || '').toLowerCase().trim()];
    if (!promo) return null;
    if (promo.durations && promo.durations.indexOf(state.duration) === -1) return null;
    if (promo.maxCourts && state.courts > promo.maxCourts) return null;
    if (promo.guestOnly && state.bookerType !== 'guest') return null;
    return promo;
  }
  function minutesOf(timeStr) { var hm = to24(timeStr); return hm[0] * 60 + hm[1]; }

  // ---------- rendering ----------
  function renderTimes() {
    var grid = el('cbTimes');
    if (!state.date) { grid.innerHTML = '<div class="cb-hint">Pick a date first.</div>'; return; }
    grid.innerHTML = '';
    var any = false;
    var pr = activePromo();
    timeSlots().forEach(function (t) {
      var free = freeCourtsAt(t), past = isPast(t);
      var mins = minutesOf(t);
      // A time-windowed promo (e.g. first-visit free court) can only start inside its window.
      var outsidePromo = pr && (pr.startMin != null && mins < pr.startMin || pr.startMax != null && mins >= pr.startMax);
      var ok = !past && free >= state.courts && !outsidePromo;
      if (ok) any = true;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cb-slot' + (ok ? '' : ' cb-slot-off') + (state.time === t ? ' cb-slot-on' : '');
      b.textContent = t;
      b.disabled = !ok;
      b.title = past ? 'Already passed'
        : outsidePromo ? 'Free first-visit court: 11:30 AM–6 PM only'
        : (free < state.courts ? free + ' of ' + state.courts + ' courts free' : '');
      b.onclick = function () { state.time = t; renderTimes(); renderSummary(); };
      grid.appendChild(b);
    });
    if (!any) grid.innerHTML = '<div class="cb-hint">No openings for ' + state.courts + ' court' + (state.courts > 1 ? 's' : '') + ' at this length. Try a shorter booking, fewer courts, or another day.</div>';
  }

  function renderSummary() {
    if (!state.date) return;
    var answered = state.bookerType === 'member' || state.bookerType === 'guest';
    var hourly = hourlyFor(state.date);
    var hours = DURATION_MINS[state.duration] / 60;
    var rental = hourly * hours * state.courts;
    var promo = PROMOS[(state.promo || '').toLowerCase().trim()];
    var promoOk = promo
      && (!promo.durations || promo.durations.indexOf(state.duration) !== -1)
      && (!promo.maxCourts || state.courts <= promo.maxCourts)
      && (!promo.guestOnly || state.bookerType === 'guest');
    var freeGuest = promoOk && promo.freeNewGuest;
    if (promoOk && typeof promo.flatRental === 'number') rental = promo.flatRental;
    if (freeGuest) rental = hourly * Math.max(0, hours - (promo.freeHours || hours)) * state.courts;
    // Reflect the first-visit callout: swap the Apply button for a confirmation once applied.
    var fvApply = el('cbFirstVisitApply'), fvDone = el('cbFirstVisitApplied');
    if (fvApply && fvDone) {
      fvApply.style.display = freeGuest ? 'none' : 'block';
      fvDone.style.display = freeGuest ? 'block' : 'none';
    }
    // The booker's own pass is never deferrable — you can't defer your own admission — so
    // only the passes for people they bring can be settled at the desk. The first-visit promo
    // also waives the new guest's own pass.
    var ownPass = state.bookerType === 'guest' ? 1 : 0;
    var billable = state.guests + ownPass;
    var ownFee = (ownPass && !freeGuest) ? VISITOR_PASS : 0;
    var addFees = state.guests * VISITOR_PASS;
    var deferred = state.payAtClub ? addFees : 0;
    // The first-visit promo waives the booker's own pass, so it must not show up as a charged pass
    // in the fee line — otherwise the line reads "$10" while "Due now" reads "$0".
    var chargedPasses = freeGuest ? state.guests : billable;
    var fees = chargedPasses * VISITOR_PASS;
    var payNow = rental + ownFee + (addFees - deferred);

    el('cbRateLine').textContent = promoOk
      ? promo.label + ' applied'
      : (isWeekendRate(state.date) ? 'Fri–Sun' : 'Mon–Thu') + ' rate · ' + money(hourly) + '/hr per court';
    el('cbRentalLine').textContent = state.courts + ' court' + (state.courts > 1 ? 's' : '') + ' × ' + state.duration.toLowerCase();
    el('cbRentalAmt').textContent = money(rental);

    var feeRow = el('cbFeeRow');
    if (answered && chargedPasses > 0) {
      feeRow.style.display = 'flex';
      var who = freeGuest
        ? state.guests + ' guest' + (state.guests > 1 ? 's' : '')
        : (state.bookerType === 'guest'
            ? (state.guests === 0 ? 'you' : 'you + ' + state.guests + ' guest' + (state.guests > 1 ? 's' : ''))
            : state.guests + ' guest' + (state.guests > 1 ? 's' : ''));
      el('cbFeeLine').textContent = 'Visitor passes (' + who + ') — ' + chargedPasses + ' × ' + money(VISITOR_PASS);
      // "$0.00 + $20.00 at club" reads like a bug; drop the zero when nothing is due now.
      var payNowFees = fees - deferred;
      el('cbFeeAmt').textContent = deferred === 0
        ? money(fees)
        : (payNowFees > 0 ? money(payNowFees) + ' now + ' + money(deferred) + ' at club'
                          : money(deferred) + ' at club');
      el('cbFeeAmt').className = deferred > 0 ? 'cb-amt cb-amt-due' : 'cb-amt';
    } else {
      feeRow.style.display = 'none';
    }

    el('cbTotalAmt').textContent = money(payNow);
    // The pay-at-club option only makes sense when something is actually owed.
    el('cbGuestFeeWrap').style.display = (answered && state.guests > 0) ? 'block' : 'none';
    var due = el('cbDueNote');
    if (deferred > 0) {
      due.style.display = 'block';
      due.textContent = 'Bring ' + money(deferred) + ' for your guest'
        + (state.guests === 1 ? "'s" : "s'") + ' visitor pass'
        + (state.guests === 1 ? '' : 'es') + ' — payable at the front desk.'
        + (ownPass ? (freeGuest ? ' Your own pass is free on your first visit.' : ' Your own pass is paid online.') : '');
    } else { due.style.display = 'none'; }
  }

  /**
   * Guest count only. Who the BOOKER is gets asked separately — cramming both into one
   * dropdown left "I'm a guest bringing 2 friends" with no obvious answer.
   */
  function renderGuestOptions() {
    var max = state.courts * 7;
    var sel = el('cbGuests'), prev = state.guests;
    sel.innerHTML = '';
    for (var i = 0; i <= max; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = i === 0 ? 'No one — just me' : i + ' guest' + (i > 1 ? 's' : '');
      sel.appendChild(o);
    }
    state.guests = Math.min(prev, max);
    sel.value = String(state.guests);
  }

  /** Everyone on court who isn't a member owes a pass — including the booker. */
  function billablePasses() {
    return state.guests + (state.bookerType === 'guest' ? 1 : 0);
  }

  async function loadAvailability() {
    var grid = el('cbTimes');
    grid.innerHTML = '<div class="cb-hint">Checking availability…</div>';
    el('cbClosed').style.display = 'none';
    try {
      var res = await fetch(WORKER + '/availability?date=' + encodeURIComponent(state.date));
      var data = await res.json();
      if (data.closed) {
        state.busy = []; state.courtTotal = 0;
        el('cbClosed').style.display = 'block';
        el('cbClosed').textContent = "We're closed on " + data.reason + '. Please pick another date.';
        grid.innerHTML = '';
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Availability unavailable');
      state.busy = data.busy || [];
      state.courtTotal = data.courtCount || 0;
      state.time = '';
      renderTimes();
      renderSummary();
    } catch (err) {
      // Never fall back to "everything is free" — that sells courts we may not have.
      grid.innerHTML = '<div class="cb-hint cb-err">Couldn\'t load availability right now. Please call us at ' + PHONE + '.</div>';
    }
  }

  // ---------- checkout ----------
  // Fire-and-forget request for a free-court email verification code.
  function sendVerifyCode(email) {
    try {
      fetch(WORKER + '/send-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
    } catch (e) { /* non-fatal; they can hit Resend */ }
  }

  async function submit() {
    var btn = el('cbSubmit');
    var errBox = el('cbError');
    errBox.style.display = 'none';

    var payload = {
      firstName: el('cbFirst').value.trim(),
      lastName: el('cbLast').value.trim(),
      email: el('cbEmail').value.trim(),
      phone: el('cbPhone').value.trim(),
      date: state.date,
      time: state.time,
      duration: state.duration,
      courtCount: state.courts,
      additionalGuests: state.guests,
      guestFeesPaidNow: !state.payAtClub,
      notes: el('cbNotes').value.trim(),
      promoCode: (el('cbPromo').value || '').trim(),
      bookerType: state.bookerType,
      verifyCode: (el('cbVerifyCode') && el('cbVerifyCode').value || '').replace(/\D/g, ''),
    };
    if (!payload.firstName || !payload.lastName || !payload.email || !payload.phone) {
      return showError('Please fill in your name, email and phone.');
    }
    if (!payload.time) return showError('Please pick a start time.');
    if (payload.bookerType !== 'member' && payload.bookerType !== 'guest') {
      return showError('Please tell us whether you\'re a member or a guest.');
    }

    btn.disabled = true; btn.textContent = 'Reserving…';
    try {
      var res = await fetch(WORKER + '/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      var data = await res.json();

      // $0 booking (free first-visit court) — the Worker already created it, no payment step.
      if (data.success && data.free) {
        markFreeClaimed();   // remember on this browser so we stop offering it again
        showStep('done');
        el('cbDoneDate').textContent = state.date;
        el('cbDoneTime').textContent = state.time + ' · ' + state.duration;
        el('cbDoneCourts').textContent = (data.courts || []).join(', ');
        el('cbDoneId').style.display = 'block';   // free first-visit booking → ID reminder
        return;
      }

      if (!res.ok || !data.clientSecret) {
        btn.disabled = false; btn.textContent = 'Continue to payment';
        if (data.conflict) { loadAvailability(); }
        // Free court needs email verification — surface the code field and focus it.
        if (data.verifyRequired) {
          el('cbVerifyWrap').style.display = 'block';
          var vc = el('cbVerifyCode'); if (vc) { vc.focus(); }
          return showError(data.error || 'Enter the 6-digit code we emailed you to claim your free court.');
        }
        // If a free-promo booking was rejected as ineligible, strip the code so the total
        // recalculates to regular price and they can just book again — no manual clearing.
        if (data.error && /Regular rates apply/i.test(data.error)) {
          el('cbPromo').value = '';
          state.promo = '';
          renderTimes(); renderSummary();
          return showError('You\'re already in our system — the free first-visit offer doesn\'t apply. We\'ve removed the code; regular rates now show below.');
        }
        return showError(data.error || 'Could not start checkout. Please call ' + PHONE + '.');
      }
      showStep('pay');
      el('cbPayCourts').textContent = (data.courts || []).join(', ');
      if (!stripe) stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
      if (embedded) { try { embedded.destroy(); } catch (e) {} }
      embedded = await stripe.initEmbeddedCheckout({
        clientSecret: data.clientSecret,
        onComplete: function () { onPaid(data.sessionId); },
      });
      embedded.mount('#cbStripe');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Continue to payment';
      showError('Something went wrong. Please call ' + PHONE + '.');
    }
  }

  async function onPaid(sessionId) {
    showStep('done');
    try {
      var res = await fetch(WORKER + '/session-status?session_id=' + encodeURIComponent(sessionId));
      var d = await res.json();
      el('cbDoneDate').textContent = d.date || state.date;
      el('cbDoneTime').textContent = (d.time || state.time) + ' · ' + (d.duration || state.duration);
      el('cbDoneCourts').textContent = d.courtNames || '—';
      if (d.guests > 0 && !d.guestFeesPaidNow) {
        el('cbDoneFee').style.display = 'block';
        el('cbDoneFee').textContent = 'Please bring ' + money((d.guestFeesDueCents || 0) / 100) + ' for visitor passes — payable at the front desk.';
      }
    } catch (e) { /* the confirmation email still carries the details */ }
  }

  function showError(msg) {
    var b = el('cbError');
    b.textContent = msg; b.style.display = 'block';
    var btn = el('cbSubmit');
    btn.disabled = false; btn.textContent = 'Continue to payment';
  }

  function showStep(step) {
    ['form', 'pay', 'done'].forEach(function (s) {
      el('cbStep-' + s).style.display = (s === step) ? 'block' : 'none';
    });
  }

  // ---------- open / close ----------
  function open() {
    root.classList.add('cb-open');
    document.body.style.overflow = 'hidden';
    document.body.classList.add('cb-modal-open');
    // Pause any playing background video (e.g. the hero) so the modal doesn't flicker over moving
    // content. Remember only the ones we actually paused, to resume them on close.
    pausedMedia = [];
    Array.prototype.forEach.call(document.querySelectorAll('video'), function (v) {
      if (!v.paused && !v.ended) { try { v.pause(); pausedMedia.push(v); } catch (e) {} }
    });
    showStep('form');
    el('cbError').style.display = 'none';
    var btn = el('cbSubmit');
    btn.disabled = false; btn.textContent = 'Continue to payment';
    if (!state.date) {
      state.date = todayStr();
      el('cbDate').value = state.date;
      el('cbDate').min = state.date;
    }
    state.bookerType = '';
    state.guests = 0;
    var whoBtns = el('cbWho').children;
    Array.prototype.forEach.call(whoBtns, function (b) { b.classList.remove('cb-pill-on'); });
    el('cbGuestsWrap').style.display = 'none';
    el('cbFirstVisit').style.display = 'none';
    var _idNote = el('cbDoneId'); if (_idNote) _idNote.style.display = 'none';
    renderGuestOptions();
    loadAvailability();
  }

  function close() {
    root.classList.remove('cb-open');
    document.body.style.overflow = '';
    document.body.classList.remove('cb-modal-open');
    // Resume the videos we paused when opening.
    pausedMedia.forEach(function (v) { try { v.play(); } catch (e) {} });
    pausedMedia = [];
    if (embedded) { try { embedded.destroy(); } catch (e) {} embedded = null; }
  }

  // ---------- build ----------
  function build() {
    root = document.createElement('div');
    root.id = 'cbRoot';
    root.innerHTML = [
      '<div class="cb-backdrop" data-cb-close></div>',
      '<div class="cb-modal" role="dialog" aria-modal="true" aria-label="Book a court">',
      '  <button class="cb-x" data-cb-close aria-label="Close">&times;</button>',

      '  <div id="cbStep-form">',
      '    <div class="cb-head"><div class="cb-eyebrow">LevelUp Pickleball Club</div><h2>Book a Court</h2></div>',
      '    <div class="cb-body">',
      '      <div class="cb-row">',
      '        <label class="cb-field"><span>Date</span><input type="date" id="cbDate"></label>',
      '        <label class="cb-field"><span>How long?</span><select id="cbDuration"></select></label>',
      '      </div>',
      '      <div id="cbClosed" class="cb-closed" style="display:none;"></div>',
      '      <div class="cb-field"><span>How many courts?</span><div class="cb-pills" id="cbCourts"></div>',
      '        <div class="cb-hint cb-hint-sm">We\'ll assign your courts — no need to pick.</div></div>',
      '      <div class="cb-field"><span>Start time</span><div class="cb-times" id="cbTimes"></div></div>',
      '      <div class="cb-field"><span>Are you a member or a guest?</span><div class="cb-pills" id="cbWho">',
      '        <button type="button" class="cb-pill" data-who="member">I\'m a member</button>',
      '        <button type="button" class="cb-pill" data-who="guest">I\'m a guest</button></div>',
      '        <div class="cb-hint cb-hint-sm" id="cbWhoHint">Members play for just the court fee. Guests pay a $10 visitor pass each.</div></div>',
      '      <div class="cb-field cb-step2" id="cbGuestsWrap" style="display:none;"><span id="cbGuestsQ">Who are you bringing?</span><select id="cbGuests"></select>',
      '        <div class="cb-hint cb-hint-sm">Every guest pays a $10 visitor pass.</div></div>',
      '      <div id="cbGuestFeeWrap" style="display:none;">',
      '        <label class="cb-check"><input type="checkbox" id="cbPayAtClub">',
      '          <span><strong>My guests will pay their $10 at the club</strong><br>',
      '          <em>Applies to the guests you bring. Leave unchecked to pay their passes now and skip the front desk.</em></span></label>',
      '      </div>',
      '      <div class="cb-row">',
      '        <label class="cb-field"><span>First name</span><input type="text" id="cbFirst" autocomplete="given-name"></label>',
      '        <label class="cb-field"><span>Last name</span><input type="text" id="cbLast" autocomplete="family-name"></label>',
      '      </div>',
      '      <div class="cb-row">',
      '        <label class="cb-field"><span>Email</span><input type="email" id="cbEmail" autocomplete="email"></label>',
      '        <label class="cb-field"><span>Phone</span><input type="tel" id="cbPhone" autocomplete="tel"></label>',
      '      </div>',
      '      <label class="cb-field"><span>Anything we should know? <em>(optional)</em></span><textarea id="cbNotes" rows="2"></textarea></label>',
      '      <label class="cb-field"><span>Promo code <em>(optional)</em></span><input type="text" id="cbPromo" autocomplete="off" placeholder="Enter code"></label>',
      '      <div id="cbFirstVisit" class="cb-firstvisit" style="display:none;">',
      '        <div class="cb-fv-head">🎉 First time at LevelUp? Your first hour is on us.</div>',
      '        <div class="cb-fv-flags"><span class="cb-fv-flag">New guests only</span><span class="cb-fv-flag">Photo ID will be required</span></div>',
      '        <div class="cb-fv-fine">Valid 11:30 AM–6 PM · one per person · book longer and only the extra time is charged.</div>',
      '        <button type="button" class="cb-fv-btn" id="cbFirstVisitApply">Check if I qualify</button>',
      '        <div class="cb-fv-applied" id="cbFirstVisitApplied" style="display:none;">✅ Free first-visit court applied</div>',
      '        <div id="cbVerifyWrap" style="display:none;margin-top:10px;">',
      '          <input type="text" id="cbVerifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" style="width:100%;box-sizing:border-box;padding:.6rem .75rem;font-size:1.1rem;letter-spacing:.3em;text-align:center;border:1px solid rgba(124,207,74,.6);border-radius:10px;background:rgba(255,255,255,.06);color:#fff;">',
      '          <button type="button" class="cb-fv-btn" id="cbVerifyBtn" style="margin-top:8px;">Enter</button>',
      '          <div style="font-size:.78rem;color:#cfeebd;margin-top:6px;">Don\'t see it? Check your spam folder.</div>',
      '        </div>',
      '      </div>',
      '      <div class="cb-summary">',
      '        <div class="cb-rate" id="cbRateLine"></div>',
      '        <div class="cb-line"><span id="cbRentalLine"></span><span class="cb-amt" id="cbRentalAmt"></span></div>',
      '        <div class="cb-line" id="cbFeeRow" style="display:none;"><span id="cbFeeLine"></span><span class="cb-amt" id="cbFeeAmt"></span></div>',
      '        <div class="cb-line cb-total"><span>Due now</span><span id="cbTotalAmt"></span></div>',
      '        <div class="cb-due" id="cbDueNote" style="display:none;"></div>',
      '      </div>',
      '      <div class="cb-err" id="cbError" style="display:none;"></div>',
      '      <button class="cb-btn" id="cbSubmit">Continue to payment</button>',
      '      <div class="cb-fine">Questions? Call ' + PHONE + '</div>',
      '    </div>',
      '  </div>',

      '  <div id="cbStep-pay" style="display:none;">',
      '    <div class="cb-head"><div class="cb-eyebrow">Step 2 of 2</div><h2>Payment</h2>',
      '      <div class="cb-assigned">Courts held for you: <strong id="cbPayCourts"></strong></div></div>',
      '    <div class="cb-body"><div id="cbStripe"></div></div>',
      '  </div>',

      '  <div id="cbStep-done" style="display:none;">',
      '    <div class="cb-body cb-done">',
      '      <h2>You\'re booked!</h2>',
      '      <div class="cb-donebox">',
      '        <div class="cb-line"><span>Date</span><strong id="cbDoneDate">—</strong></div>',
      '        <div class="cb-line"><span>Time</span><strong id="cbDoneTime">—</strong></div>',
      '        <div class="cb-line"><span>Courts</span><strong id="cbDoneCourts">—</strong></div>',
      '      </div>',
      '      <div class="cb-due" id="cbDoneFee" style="display:none;"></div>',
      '      <div class="cb-due" id="cbDoneId" style="display:none;">Please bring a photo ID — we will verify it at the front desk for the free first-visit court.</div>',
      '      <div class="cb-waiver" style="background:rgba(60,196,64,0.1);border:1px solid rgba(60,196,64,0.5);border-radius:8px;padding:1.1rem 1rem;margin:1.25rem 0 0.5rem;text-align:center;">',
      '        <div style="color:#fff;font-size:1rem;font-weight:600;margin-bottom:0.75rem;line-height:1.4;">Every guest must complete our waiver before playing.</div>',
      '        <a href="https://www.leveluppickleballclub.com/waiver" target="_blank" rel="noopener"',
      '           style="display:inline-block;background:#3CC440;color:#0d1020;font-family:inherit;font-weight:800;font-size:0.95rem;letter-spacing:0.08em;text-transform:uppercase;padding:0.7rem 1.4rem;border-radius:6px;text-decoration:none;">Fill out the waiver →</a>',
      '      </div>',
      '      <p class="cb-fine">A confirmation email is on its way. Need to change something? Call ' + PHONE + '.</p>',
      '      <button class="cb-btn" data-cb-close>Done</button>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(root);

    var dur = el('cbDuration');
    DURATIONS.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d; o.textContent = d;
      if (d === state.duration) o.selected = true;
      dur.appendChild(o);
    });

    var pills = el('cbCourts');
    for (var i = 1; i <= 4; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'cb-pill' + (n === state.courts ? ' cb-pill-on' : '');
        b.textContent = n;
        b.onclick = function () {
          state.courts = n;
          Array.prototype.forEach.call(pills.children, function (c) { c.classList.remove('cb-pill-on'); });
          b.classList.add('cb-pill-on');
          renderGuestOptions(); renderTimes(); renderSummary();
        };
        pills.appendChild(b);
      })(i);
    }

    el('cbDate').onchange = function () { state.date = this.value; loadAvailability(); };
    dur.onchange = function () { state.duration = this.value; state.time = ''; renderTimes(); renderSummary(); };
    el('cbGuests').onchange = function () {
      state.guests = parseInt(this.value) || 0;
      renderSummary();
    };

    var whoWrap = el('cbWho');
    Array.prototype.forEach.call(whoWrap.children, function (btn) {
      btn.onclick = function () {
        state.bookerType = btn.getAttribute('data-who');
        Array.prototype.forEach.call(whoWrap.children, function (b) { b.classList.remove('cb-pill-on'); });
        btn.classList.add('cb-pill-on');
        // Second question only appears once the first is answered.
        var wrap = el('cbGuestsWrap');
        wrap.style.display = 'block';
        el('cbGuestsQ').textContent = state.bookerType === 'guest'
          ? 'Anyone coming with you?'
          : 'Are you bringing guests?';
        el('cbWhoHint').textContent = state.bookerType === 'guest'
          ? 'You\'ll pay a $10 visitor pass, plus $10 for anyone you bring.'
          : 'You play for just the court fee. Each guest you bring pays $10.';
        // First-visit offer only makes sense for guests. Reset the check button/message each time
        // so a prior "you qualify" (or a "no") doesn't linger from an earlier selection.
        el('cbFirstVisit').style.display = (state.bookerType === 'guest' && !freeClaimed()) ? 'block' : 'none';
        el('cbFirstVisitApply').style.display = '';
        el('cbFirstVisitApply').disabled = false;
        el('cbFirstVisitApply').textContent = 'Check if I qualify';
        el('cbFirstVisitApplied').style.display = 'none';
        el('cbVerifyWrap').style.display = 'none';
        el('cbVerifyCode').value = '';
        renderSummary();
      };
    });
    el('cbPayAtClub').onchange = function () { state.payAtClub = this.checked; renderSummary(); };
    el('cbPromo').oninput = function () { state.promo = this.value; renderSummary(); };

    el('cbFirstVisitApply').onclick = async function () {
      var btn = this, note = el('cbFirstVisitApplied');
      var first = el('cbFirst').value.trim(), last = el('cbLast').value.trim();
      var email = el('cbEmail').value.trim(), phone = el('cbPhone').value.trim();
      function fvMsg(text, ok) {
        note.style.display = 'block';
        note.textContent = text;
        note.style.marginTop = '10px';
        note.style.color = ok ? '' : '#f3c9c9';   // soft red for a "no", default green for a "yes"
      }
      // Ask for name here too (they'll need it to book anyway) — the eligibility match itself only
      // uses email + phone, but prompting for the full set keeps the form complete up front.
      if (!first || !last || !email || !phone) { fvMsg('Enter your name, email and phone above, then check again.', false); return; }

      var label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Checking…'; note.style.display = 'none';
      try {
        var res = await fetch(WORKER + '/check-eligible', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email, phone: phone, date: state.date, time: state.time,
            promoCode: 'FIRSTSERVE', bookerType: state.bookerType,
          }),
        });
        if (res.status === 429) { fvMsg('One moment — please try again in a few seconds.', false); btn.disabled = false; btn.textContent = label; return; }
        var data = await res.json();
        if (data.eligible) {
          el('cbPromo').value = 'FIRSTSERVE';
          state.promo = 'FIRSTSERVE';
          // Nudge them to a valid time if their current pick is outside the 11:30–6 window.
          if (state.time && (minutesOf(state.time) < 690 || minutesOf(state.time) >= 1080)) state.time = '';
          renderTimes(); renderSummary();
          // Free court requires email verification — email a code and reveal the entry field.
          sendVerifyCode(email);
          fvMsg('✅ You qualify! We emailed a 6-digit code to ' + email + ' — enter it below to lock in your free court.', true);
          el('cbVerifyWrap').style.display = 'block';
          btn.style.display = 'none';
        } else {
          // Not eligible — make sure the code isn't lingering, show the real price and the reason.
          el('cbPromo').value = ''; state.promo = '';
          el('cbVerifyWrap').style.display = 'none';
          renderTimes(); renderSummary();
          fvMsg(data.reason || 'This offer is for new guests — regular rates apply.', false);
          btn.disabled = false; btn.textContent = label;
        }
      } catch (e) {
        fvMsg('Could not check right now — you can still book at regular rates.', false);
        btn.disabled = false; btn.textContent = label;
      }
    };
    el('cbVerifyBtn').onclick = submit;
    el('cbVerifyCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    el('cbSubmit').onclick = submit;

    // Scrolling the modal with the cursor over a <select> would otherwise change its value —
    // silently altering the booking and its price. Forward the wheel to the modal instead.
    var modalEl = root.querySelector('.cb-modal');
    Array.prototype.forEach.call(root.querySelectorAll('select'), function (s) {
      s.addEventListener('wheel', function (e) {
        e.preventDefault();
        modalEl.scrollTop += e.deltaY;
      }, { passive: false });
    });

    root.addEventListener('click', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-cb-close')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('cb-open')) close();
    });

    injectStripeJs();
  }

  function injectStripeJs() {
    if (window.Stripe) return;
    var s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    document.head.appendChild(s);
  }

  function bindTriggers() {
    var links = document.querySelectorAll('a[href*="publicbookings/12674"], [data-book-court]');
    Array.prototype.forEach.call(links, function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        open();
      });
    });
  }

  function init() {
    try {
      build();
      bindTriggers(); // only after the modal exists, so a failure above leaves links intact
      if (freeClaimed()) hideFreeOffer(); // returning claimer → don't dangle the free offer again
    } catch (err) {
      if (window.console) console.error('Court booking modal failed to init:', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
