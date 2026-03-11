// ========== GitSlim - Weight Tracking App ==========

(function () {
  'use strict';

  // ===== State =====
  const STORAGE_KEY = 'gitslim_data';
  const defaults = {
    name: '',
    unit: 'lbs',
    goalWeight: 165,
    heightIn: 70, // total inches
    entries: [],   // { date: 'YYYY-MM-DD', weight: number, ts: number }
    xp: 0,
    level: 1,
    achievements: [],
    fastStartHour: 19,  // 7pm
    fastEndHour: 13,     // 1pm
    fasts: [],           // { start: ts, end: ts|null }
    fastingStreak: 0,
    onboarded: false,
    chao: [],            // array of chao objects
    activeChao: 0,       // index of selected chao
    petLastFed: null,    // timestamp of last interaction
  };

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    return { ...defaults };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ===== DOM Refs =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ===== Init =====
  function init() {
    if (!state.onboarded) {
      showScreen('onboarding');
    } else {
      showScreen('dashboard');
      renderDashboard();
    }
    bindEvents();
    startFastingTicker();
  }

  function showScreen(name) {
    $$('.screen').forEach(s => s.classList.add('hidden'));
    $(`#${name}`).classList.remove('hidden');
  }

  // ===== Events =====
  function bindEvents() {
    // Onboarding
    $('#onboard-start').addEventListener('click', handleOnboard);

    // Log weight
    $('#log-weight-btn').addEventListener('click', handleLogWeight);
    $('#weight-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogWeight();
    });

    // Chart range
    $$('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderChart(btn.dataset.range);
      });
    });

    // Settings
    $('#settings-btn').addEventListener('click', openSettings);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#settings-save').addEventListener('click', saveSettings);
    $('#settings-modal').addEventListener('click', (e) => {
      if (e.target === $('#settings-modal')) closeSettings();
    });

    // Export / Import
    $('#export-btn').addEventListener('click', exportCSV);
    $('#import-btn').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', importCSV);

    // Reset
    $('#reset-btn').addEventListener('click', handleReset);

    // Pet the Chao (tap canvas)
    $('#pet-canvas').addEventListener('click', handlePetChao);
    $('#pet-canvas').addEventListener('touchstart', (e) => {
      e.preventDefault();
      handlePetChao(e.touches[0]);
    }, { passive: false });

    // Fasting
    $('#fasting-start-btn').addEventListener('click', startFast);
    $('#fasting-end-btn').addEventListener('click', endFast);

    // Bottom nav (mobile)
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        handleNavTab(tab);
      });
    });
  }

  // ===== Onboarding =====
  function handleOnboard() {
    const name = $('#onboard-name').value.trim();
    const weight = parseFloat($('#onboard-weight').value);
    const goal = parseFloat($('#onboard-goal').value);
    const unit = $('#onboard-unit').value;
    const ft = parseInt($('#onboard-height-ft').value) || 5;
    const inches = parseInt($('#onboard-height-in').value) || 10;

    if (!weight || weight < 50) {
      showToast('Please enter your current weight', 'error');
      return;
    }
    if (!goal || goal < 50) {
      showToast('Please enter a goal weight', 'error');
      return;
    }

    const petName = ($('#onboard-pet-name').value || '').trim();
    state.name = name || 'Friend';
    state.unit = unit;
    state.goalWeight = goal;
    state.heightIn = ft * 12 + inches;
    state.chao = [createChao(petName || 'Buddy', 'neutral')];
    state.activeChao = 0;
    state.petLastFed = Date.now();
    state.onboarded = true;

    // Log first entry
    addEntry(weight);
    addXP(50, 'Welcome bonus!');

    save();
    showScreen('dashboard');
    renderDashboard();
  }

  // ===== Weight Logging =====
  function handleLogWeight() {
    const input = $('#weight-input');
    const weight = parseFloat(input.value);
    if (!weight || weight < 50 || weight > 999) {
      showToast('Enter a valid weight', 'error');
      return;
    }

    const today = dateStr(new Date());
    const existing = state.entries.findIndex(e => e.date === today);
    if (existing >= 0) {
      // Keep the lower weight for the day
      const prev = state.entries[existing].weight;
      if (weight < prev) {
        state.entries[existing].weight = weight;
        state.entries[existing].ts = Date.now();
      } else if (weight >= prev) {
        // Still record the time but keep the lower weight
        state.entries[existing].ts = Date.now();
        showToast(`Keeping today's lower: ${prev.toFixed(1)} ${state.unit} (you entered ${weight.toFixed(1)})`, 'success');
        // Still feed pet and give XP for logging
        feedPet('log');
        addXP(10, 'Weight logged!');
        const streak = calcStreak();
        if (streak >= 3) { addXP(5, `${streak}-day streak!`); feedPet('streak'); }
        if (streak >= 7) addXP(10, '7-day streak bonus!');
        checkAchievements();
        save();
        input.value = '';
        renderDashboard();
        return;
      }
    } else {
      addEntry(weight);
    }

    // Feed the pet
    feedPet('log');

    // XP for logging
    addXP(10, 'Weight logged!');

    // Streak check
    const streak = calcStreak();
    if (streak >= 3) { addXP(5, `${streak}-day streak!`); feedPet('streak'); }
    if (streak >= 7) addXP(10, '7-day streak bonus!');

    // Check for new lows
    const allWeights = state.entries.map(e => e.weight);
    if (weight <= Math.min(...allWeights)) {
      addXP(25, 'New all-time low!');
    }

    // Check achievements
    checkAchievements();

    save();
    input.value = '';
    renderDashboard();
    showToast(`Logged ${weight} ${state.unit}`, 'success');
  }

  function addEntry(weight) {
    state.entries.push({
      date: dateStr(new Date()),
      weight: weight,
      ts: Date.now()
    });
  }

  function deleteEntry(index) {
    state.entries.splice(index, 1);
    save();
    renderDashboard();
    showToast('Entry deleted', 'success');
  }

  // ===== XP & Leveling =====
  function addXP(amount, reason) {
    state.xp += amount;
    const newLevel = Math.floor(state.xp / 100) + 1;
    if (newLevel > state.level) {
      state.level = newLevel;
      setTimeout(() => showToast(`Level up! You're now Level ${newLevel}`, 'xp'), 800);
    }
    save();
    if (reason) {
      showToast(`+${amount} XP - ${reason}`, 'xp');
    }
  }

  // ===== Achievements =====
  const ACHIEVEMENTS = [
    { id: 'first_log', icon: '\u{1F4DD}', name: 'First Log', desc: 'Log your first weight', check: (s) => s.entries.length >= 1 },
    { id: 'week_streak', icon: '\u{1F525}', name: '7-Day Streak', desc: 'Log weight 7 days in a row', check: (s) => calcStreak() >= 7 },
    { id: 'month_streak', icon: '\u{1F3C6}', name: '30-Day Streak', desc: 'Log weight 30 days in a row', check: (s) => calcStreak() >= 30 },
    { id: 'lost_5', icon: '\u{2B50}', name: 'Down 5', desc: `Lose 5 ${() => state.unit}`, check: (s) => totalLost() >= 5 },
    { id: 'lost_10', icon: '\u{1F31F}', name: 'Down 10', desc: 'Lose 10 total', check: (s) => totalLost() >= 10 },
    { id: 'lost_20', icon: '\u{1F4AA}', name: 'Down 20', desc: 'Lose 20 total', check: (s) => totalLost() >= 20 },
    { id: 'lost_50', icon: '\u{1F451}', name: 'Down 50', desc: 'Lose 50 total', check: (s) => totalLost() >= 50 },
    { id: 'goal_reached', icon: '\u{1F3AF}', name: 'Goal!', desc: 'Reach your goal weight', check: (s) => s.entries.length > 0 && lastWeight() <= s.goalWeight },
    { id: 'ten_logs', icon: '\u{1F4CA}', name: 'Dedicated', desc: 'Log 10 entries', check: (s) => s.entries.length >= 10 },
    { id: 'fifty_logs', icon: '\u{1F9E0}', name: 'Committed', desc: 'Log 50 entries', check: (s) => s.entries.length >= 50 },
    { id: 'fast_3', icon: '\u{23F0}', name: 'Faster', desc: 'Complete 3 fasts', check: (s) => completedFasts() >= 3 },
    { id: 'fast_10', icon: '\u{26A1}', name: 'Fasting Pro', desc: 'Complete 10 fasts', check: (s) => completedFasts() >= 10 },
    { id: 'level_5', icon: '\u{1F680}', name: 'Level 5', desc: 'Reach Level 5', check: (s) => s.level >= 5 },
    { id: 'level_10', icon: '\u{1F30D}', name: 'Level 10', desc: 'Reach Level 10', check: (s) => s.level >= 10 },
    { id: 'normal_bmi', icon: '\u{1F49A}', name: 'Healthy BMI', desc: 'Reach a BMI under 25', check: (s) => s.entries.length > 0 && calcBMI(lastWeight()) < 25 },
  ];

  function checkAchievements() {
    ACHIEVEMENTS.forEach(a => {
      if (!state.achievements.includes(a.id) && a.check(state)) {
        state.achievements.push(a.id);
        feedPet('achievement');
        addXP(50, '');
        setTimeout(() => showAchievement(a), 500);
      }
    });
    save();
  }

  function showAchievement(a) {
    const popup = $('#achievement-popup');
    $('#achievement-popup-icon').textContent = a.icon;
    $('#achievement-popup-title').textContent = `Achievement: ${a.name}`;
    $('#achievement-popup-desc').textContent = a.desc;
    popup.classList.remove('hidden');
    setTimeout(() => popup.classList.add('hidden'), 3500);
  }

  // ===== Fasting =====
  function startFast() {
    state.fasts.push({ start: Date.now(), end: null });
    save();
    renderFasting();
    showToast('Fast started! You got this!', 'success');
  }

  function endFast() {
    const current = currentFast();
    if (current) {
      current.end = Date.now();
      const hours = (current.end - current.start) / 3600000;
      if (hours >= getRequiredFastHours()) {
        state.fastingStreak++;
        feedPet('fast_complete');
        addXP(20, `Fast complete! ${hours.toFixed(1)}h`);
      } else {
        state.fastingStreak = 0;
        showToast(`Fast ended early (${hours.toFixed(1)}h)`, 'error');
      }
      save();
      checkAchievements();
      renderFasting();
    }
  }

  function currentFast() {
    if (state.fasts.length === 0) return null;
    const last = state.fasts[state.fasts.length - 1];
    return last.end === null ? last : null;
  }

  function completedFasts() {
    return state.fasts.filter(f => f.end !== null).length;
  }

  function getRequiredFastHours() {
    // Hours from fast start to fast end next day
    let hours = state.fastEndHour - state.fastStartHour;
    if (hours <= 0) hours += 24;
    return hours;
  }

  function startFastingTicker() {
    setInterval(renderFastingTimer, 1000);
  }

  function renderFastingTimer() {
    const fast = currentFast();
    const ring = $('#fasting-ring-progress');
    const timeEl = $('#fasting-time');
    const labelEl = $('#fasting-label');

    if (!fast) {
      ring.style.strokeDashoffset = 339.292;
      timeEl.textContent = '--:--';
      labelEl.textContent = 'not fasting';
      return;
    }

    const elapsed = (Date.now() - fast.start) / 1000; // seconds
    const target = getRequiredFastHours() * 3600;
    const remaining = Math.max(0, target - elapsed);
    const progress = Math.min(elapsed / target, 1);

    ring.style.strokeDashoffset = 339.292 * (1 - progress);

    if (remaining > 0) {
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      timeEl.textContent = `${h}h ${m.toString().padStart(2, '0')}m`;
      labelEl.textContent = 'remaining';
    } else {
      timeEl.textContent = 'Done!';
      labelEl.textContent = 'fast complete';
      ring.style.stroke = 'var(--green)';
    }

    if (progress < 0.5) ring.style.stroke = 'var(--accent)';
    else if (progress < 1) ring.style.stroke = 'var(--yellow)';
    else ring.style.stroke = 'var(--green)';
  }

  // ===== Rendering =====
  function renderDashboard() {
    renderGreeting();
    renderQuickStats();
    renderPet();
    startPetAnimation();
    renderStats();
    renderChart('7');
    renderFasting();
    renderAchievements();
    renderHistory();
    renderHeaderBadges();
  }

  function renderGreeting() {
    const hour = new Date().getHours();
    let greet = 'Good evening';
    if (hour < 12) greet = 'Good morning';
    else if (hour < 17) greet = 'Good afternoon';
    $('#greeting').textContent = `${greet}, ${state.name}!`;
    $('#xp-display').textContent = `${state.xp} XP`;
    $('#weight-unit-label').textContent = state.unit;
  }

  function renderHeaderBadges() {
    const streak = calcStreak();
    $('#streak-badge').innerHTML = `${streak} \u{1F525}`;
    $('#level-badge').textContent = `Lv ${state.level}`;
  }

  function renderQuickStats() {
    const el = $('#quick-stats');
    if (state.entries.length < 2) {
      el.innerHTML = '<span style="color:var(--text3)">Log daily to see trends</span>';
      return;
    }
    const last = lastWeight();
    const prev = state.entries[state.entries.length - 2].weight;
    const diff = last - prev;
    const sign = diff <= 0 ? '' : '+';
    const cls = diff <= 0 ? 'positive' : 'negative';
    const startW = state.entries[0].weight;
    const totalDiff = last - startW;
    const totalSign = totalDiff <= 0 ? '' : '+';
    const totalCls = totalDiff <= 0 ? 'positive' : 'negative';

    el.innerHTML = `
      <div class="quick-stat-item">
        <div class="quick-stat-value ${cls}">${sign}${diff.toFixed(1)}</div>
        <div>vs last</div>
      </div>
      <div class="quick-stat-item">
        <div class="quick-stat-value ${totalCls}">${totalSign}${totalDiff.toFixed(1)}</div>
        <div>total</div>
      </div>
      <div class="quick-stat-item">
        <div class="quick-stat-value">${((state.goalWeight - last) > 0 ? '+' : '') + (last - state.goalWeight).toFixed(1)}</div>
        <div>to goal</div>
      </div>
    `;
  }

  function renderStats() {
    if (state.entries.length === 0) return;
    const last = lastWeight();
    const start = state.entries[0].weight;
    const lost = start - last;
    const toGoal = last - state.goalWeight;
    const bmi = calcBMI(last);

    $('#stat-current').textContent = `${last.toFixed(1)}`;
    $('#stat-lost').textContent = `${lost >= 0 ? '-' : '+'}${Math.abs(lost).toFixed(1)}`;
    $('#stat-lost').style.color = lost >= 0 ? 'var(--green)' : 'var(--primary)';
    $('#stat-bmi').textContent = bmi.toFixed(1);
    $('#stat-bmi').style.color = bmi < 25 ? 'var(--green)' : bmi < 30 ? 'var(--yellow)' : 'var(--primary)';
    $('#stat-togoal').textContent = `${toGoal > 0 ? '' : ''}${toGoal.toFixed(1)}`;
    $('#stat-togoal').style.color = toGoal <= 0 ? 'var(--green)' : 'var(--text)';

    // Weekly average
    const weeklyAvg = calcWeeklyAvg();
    $('#stat-weekly').textContent = weeklyAvg !== null ? `${weeklyAvg >= 0 ? '+' : ''}${weeklyAvg.toFixed(1)}` : '--';
    if (weeklyAvg !== null) {
      $('#stat-weekly').style.color = weeklyAvg <= 0 ? 'var(--green)' : 'var(--primary)';
    }

    // Best week
    const bestWeek = calcBestWeek();
    $('#stat-best').textContent = bestWeek !== null ? `-${Math.abs(bestWeek).toFixed(1)}` : '--';
    if (bestWeek !== null) {
      $('#stat-best').style.color = 'var(--green)';
    }
  }

  function renderFasting() {
    const fast = currentFast();
    if (fast) {
      $('#fasting-start-btn').classList.add('hidden');
      $('#fasting-end-btn').classList.remove('hidden');
    } else {
      $('#fasting-start-btn').classList.remove('hidden');
      $('#fasting-end-btn').classList.add('hidden');
    }
    const completed = completedFasts();
    const fStreak = state.fastingStreak;
    $('#fasting-streak-display').textContent = completed > 0
      ? `${completed} fasts completed | ${fStreak} streak`
      : 'No fasts completed yet';
    renderFastingTimer();
  }

  function renderAchievements() {
    const grid = $('#achievements-grid');
    grid.innerHTML = ACHIEVEMENTS.map(a => {
      const unlocked = state.achievements.includes(a.id);
      return `
        <div class="achievement ${unlocked ? 'unlocked' : 'locked'}" title="${a.desc}">
          <div class="achievement-icon">${a.icon}</div>
          <div class="achievement-name">${a.name}</div>
        </div>
      `;
    }).join('');
  }

  function renderHistory() {
    const list = $('#history-list');
    const sorted = [...state.entries].reverse();
    const display = sorted.slice(0, 30);
    if (display.length === 0) {
      list.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px;">No entries yet</div>';
      return;
    }
    list.innerHTML = display.map((entry, i) => {
      const realIndex = state.entries.length - 1 - i;
      const prev = realIndex > 0 ? state.entries[realIndex - 1].weight : null;
      const diff = prev !== null ? entry.weight - prev : 0;
      const sign = diff <= 0 ? '' : '+';
      const cls = diff < 0 ? 'down' : diff > 0 ? 'up' : '';
      const dateFormatted = formatDate(entry.date);
      const time = formatTime(entry.ts);
      return `
        <div class="history-item">
          <div class="history-date-col">
            <div class="history-date">${dateFormatted}</div>
            <div class="history-time">${time}</div>
          </div>
          <div class="history-weight">${entry.weight.toFixed(1)} ${state.unit}</div>
          <div class="history-change ${cls}">${prev !== null ? `${sign}${diff.toFixed(1)}` : '--'}</div>
          <div class="history-actions">
            <button class="history-delete" onclick="window.__deleteEntry(${realIndex})" title="Delete">&times;</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Expose delete to onclick
  window.__deleteEntry = (i) => {
    if (confirm('Delete this entry?')) deleteEntry(i);
  };

  // ===== Chart =====
  function renderChart(range) {
    const canvas = $('#weight-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    let entries = [...state.entries].sort((a, b) => a.date.localeCompare(b.date));
    if (range !== 'all') {
      const days = parseInt(range);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = dateStr(cutoff);
      entries = entries.filter(e => e.date >= cutoffStr);
    }

    if (entries.length < 2) {
      ctx.fillStyle = '#5a5a7a';
      ctx.font = '14px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Need at least 2 entries to show chart', rect.width / 2, rect.height / 2);
      $('#chart-summary').innerHTML = '';
      return;
    }

    const weights = entries.map(e => e.weight);
    const minW = Math.min(...weights) - 2;
    const maxW = Math.max(...weights) + 2;
    const w = rect.width;
    const h = rect.height;
    const padX = 45;
    const padY = 20;
    const chartW = w - padX - 16;
    const chartH = h - padY * 2;

    // Grid lines
    ctx.strokeStyle = '#2a2a4a';
    ctx.lineWidth = 0.5;
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const y = padY + (chartH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - 16, y);
      ctx.stroke();

      const val = maxW - (maxW - minW) * (i / gridLines);
      ctx.fillStyle = '#5a5a7a';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(0), padX - 8, y + 4);
    }

    // Goal line
    if (state.goalWeight >= minW && state.goalWeight <= maxW) {
      const goalY = padY + chartH * (1 - (state.goalWeight - minW) / (maxW - minW));
      ctx.strokeStyle = 'rgba(0, 200, 83, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padX, goalY);
      ctx.lineTo(w - 16, goalY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0, 200, 83, 0.6)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Goal', w - 50, goalY - 5);
    }

    // Weight line
    const gradient = ctx.createLinearGradient(0, padY, 0, padY + chartH);
    gradient.addColorStop(0, 'rgba(233, 69, 96, 0.3)');
    gradient.addColorStop(1, 'rgba(233, 69, 96, 0)');

    // Area fill
    ctx.beginPath();
    entries.forEach((entry, i) => {
      const x = padX + (i / (entries.length - 1)) * chartW;
      const y = padY + chartH * (1 - (entry.weight - minW) / (maxW - minW));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastX = padX + chartW;
    const firstX = padX;
    ctx.lineTo(lastX, padY + chartH);
    ctx.lineTo(firstX, padY + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line
    ctx.beginPath();
    entries.forEach((entry, i) => {
      const x = padX + (i / (entries.length - 1)) * chartW;
      const y = padY + chartH * (1 - (entry.weight - minW) / (maxW - minW));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Points
    entries.forEach((entry, i) => {
      const x = padX + (i / (entries.length - 1)) * chartW;
      const y = padY + chartH * (1 - (entry.weight - minW) / (maxW - minW));
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#e94560';
      ctx.fill();
      ctx.strokeStyle = '#0f0f1a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Summary
    const first = entries[0].weight;
    const last = entries[entries.length - 1].weight;
    const change = last - first;
    const rangeMin = Math.min(...weights);
    const rangeMax = Math.max(...weights);
    const summary = $('#chart-summary');
    summary.innerHTML = `
      <div class="chart-summary-item">
        <div class="chart-summary-value" style="color:${change <= 0 ? 'var(--green)' : 'var(--primary)'}">
          ${change <= 0 ? '' : '+'}${change.toFixed(1)} ${state.unit}
        </div>
        <div class="chart-summary-label">Change</div>
      </div>
      <div class="chart-summary-item">
        <div class="chart-summary-value">${rangeMin.toFixed(1)}</div>
        <div class="chart-summary-label">Low</div>
      </div>
      <div class="chart-summary-item">
        <div class="chart-summary-value">${rangeMax.toFixed(1)}</div>
        <div class="chart-summary-label">High</div>
      </div>
    `;
  }

  // ===== Nav =====
  function handleNavTab(tab) {
    if (tab === 'log') {
      $('#weight-input').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tab === 'home') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tab === 'pet') {
      $('.pet-section').scrollIntoView({ behavior: 'smooth' });
    } else if (tab === 'stats') {
      $('.stats-section').scrollIntoView({ behavior: 'smooth' });
    } else if (tab === 'trophies') {
      $('.achievements-section').scrollIntoView({ behavior: 'smooth' });
    }
  }

  // ===== Settings =====
  function openSettings() {
    $('#settings-name').value = state.name;
    const ac = getActiveChao();
    $('#settings-pet-name').value = ac ? ac.name : '';
    $('#settings-goal').value = state.goalWeight;
    $('#settings-unit').value = state.unit;
    $('#settings-unit-label').textContent = state.unit;
    $('#settings-height-ft').value = Math.floor(state.heightIn / 12);
    $('#settings-height-in').value = state.heightIn % 12;
    $('#settings-fast-start').value = state.fastStartHour;
    $('#settings-fast-end').value = state.fastEndHour;
    $('#settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    $('#settings-modal').classList.add('hidden');
  }

  function saveSettings() {
    state.name = $('#settings-name').value.trim() || 'Friend';
    const settingsChao = getActiveChao();
    if (settingsChao) settingsChao.name = $('#settings-pet-name').value.trim() || 'Buddy';
    state.goalWeight = parseFloat($('#settings-goal').value) || state.goalWeight;
    state.unit = $('#settings-unit').value;
    const ft = parseInt($('#settings-height-ft').value) || 5;
    const inches = parseInt($('#settings-height-in').value) || 10;
    state.heightIn = ft * 12 + inches;
    state.fastStartHour = parseInt($('#settings-fast-start').value);
    state.fastEndHour = parseInt($('#settings-fast-end').value);
    save();
    closeSettings();
    renderDashboard();
    showToast('Settings saved!', 'success');
  }

  function handleReset() {
    if (confirm('This will delete ALL your data. Are you sure?')) {
      if (confirm('Really? This cannot be undone.')) {
        localStorage.removeItem(STORAGE_KEY);
        state = { ...defaults };
        showScreen('onboarding');
      }
    }
  }

  // ===== Export / Import =====
  function exportCSV() {
    const rows = [['Date', 'Weight', `Unit: ${state.unit}`]];
    state.entries.forEach(e => rows.push([e.date, e.weight, state.unit]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gitslim_${dateStr(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported!', 'success');
  }

  function importCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split('\n').slice(1);
      let imported = 0;
      lines.forEach(line => {
        const [date, weight] = line.split(',');
        if (date && weight) {
          const w = parseFloat(weight);
          if (w && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const existing = state.entries.findIndex(e => e.date === date);
            if (existing >= 0) {
              state.entries[existing].weight = w;
            } else {
              state.entries.push({ date, weight: w, ts: Date.now() });
            }
            imported++;
          }
        }
      });
      state.entries.sort((a, b) => a.date.localeCompare(b.date));
      save();
      renderDashboard();
      showToast(`Imported ${imported} entries!`, 'success');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ===== Helpers =====
  function lastWeight() {
    if (state.entries.length === 0) return 0;
    return state.entries[state.entries.length - 1].weight;
  }

  function totalLost() {
    if (state.entries.length < 2) return 0;
    return state.entries[0].weight - lastWeight();
  }

  function calcBMI(weightVal) {
    // BMI = (weight_lbs / height_in^2) * 703
    let w = weightVal;
    if (state.unit === 'kg') w = w * 2.20462;
    return (w / (state.heightIn * state.heightIn)) * 703;
  }

  function calcStreak() {
    if (state.entries.length === 0) return 0;
    const dates = new Set(state.entries.map(e => e.date));
    let streak = 0;
    const d = new Date();
    // Check if today or yesterday was logged (allow for not-yet-logged today)
    const todayStr = dateStr(d);
    if (!dates.has(todayStr)) {
      d.setDate(d.getDate() - 1);
    }
    while (dates.has(dateStr(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  function calcWeeklyAvg() {
    if (state.entries.length < 2) return null;
    const sorted = [...state.entries].sort((a, b) => a.date.localeCompare(b.date));
    const first = new Date(sorted[0].date);
    const last = new Date(sorted[sorted.length - 1].date);
    const weeks = Math.max((last - first) / (7 * 86400000), 1);
    const totalChange = sorted[sorted.length - 1].weight - sorted[0].weight;
    return totalChange / weeks;
  }

  function calcBestWeek() {
    if (state.entries.length < 2) return null;
    const sorted = [...state.entries].sort((a, b) => a.date.localeCompare(b.date));
    let bestDrop = 0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const daysDiff = (new Date(sorted[j].date) - new Date(sorted[i].date)) / 86400000;
        if (daysDiff >= 5 && daysDiff <= 9) {
          const drop = sorted[i].weight - sorted[j].weight;
          if (drop > bestDrop) bestDrop = drop;
        }
      }
    }
    return bestDrop > 0 ? bestDrop : null;
  }

  function dateStr(d) {
    return d.toISOString().split('T')[0];
  }

  function formatDate(str) {
    const d = new Date(str + 'T12:00:00');
    const now = new Date();
    const today = dateStr(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    if (str === today) return 'Today';
    if (str === dateStr(yesterday)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ===== Toast =====
  function showToast(message, type = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  // ===== Chao Garden System =====
  // Inspired by SA2 Chao Garden - raise multiple Chao through your fitness journey

  // Chao types with color palettes
  const CHAO_TYPES = {
    neutral:  { body: '#5bc0eb', highlight: '#8dd8f8', belly: '#d4f1ff', bobble: '#ffd600', name: 'Neutral' },
    hero:     { body: '#5ce05c', highlight: '#8ef08e', belly: '#d4ffd4', bobble: '#ff69b4', name: 'Hero' },
    dark:     { body: '#9b59b6', highlight: '#c39bd3', belly: '#e8d5f5', bobble: '#e74c3c', name: 'Dark' },
    power:    { body: '#e74c3c', highlight: '#f1948a', belly: '#fadbd8', bobble: '#ffd600', name: 'Power' },
    swim:     { body: '#00bcd4', highlight: '#4dd0e1', belly: '#b2ebf2', bobble: '#00e676', name: 'Swim' },
    fly:      { body: '#ff9800', highlight: '#ffb74d', belly: '#ffe0b2', bobble: '#e040fb', name: 'Fly' },
    run:      { body: '#e91e63', highlight: '#f06292', belly: '#f8bbd0', bobble: '#00e5ff', name: 'Run' },
    chaos:    { body: '#ffd600', highlight: '#ffeb3b', belly: '#fff9c4', bobble: '#00e5ff', name: 'Chaos' },
  };

  // Unlock milestones: [type, trigger description, check function]
  const CHAO_UNLOCKS = [
    { type: 'hero',  desc: 'Reach Level 3',     check: () => state.level >= 3 },
    { type: 'dark',  desc: 'Complete 5 fasts',   check: () => completedFasts() >= 5 },
    { type: 'power', desc: 'Lose 10 total',      check: () => totalLost() >= 10 },
    { type: 'swim',  desc: '14-day streak',      check: () => calcStreak() >= 14 },
    { type: 'fly',   desc: 'Reach Level 7',      check: () => state.level >= 7 },
    { type: 'run',   desc: 'Lose 25 total',      check: () => totalLost() >= 25 },
    { type: 'chaos', desc: 'Reach goal weight',  check: () => state.entries.length > 0 && lastWeight() <= state.goalWeight },
  ];

  function createChao(name, type) {
    return {
      name: name,
      type: type,
      happiness: 80,
      energy: 80,
      stage: 0,   // 0=egg, 1=child, 2=teen, 3=adult, 4=chaos
      xp: 0,      // chao-specific XP for evolution
      born: Date.now(),
      lastFed: Date.now(),
    };
  }

  function getActiveChao() {
    if (!state.chao || state.chao.length === 0) return null;
    return state.chao[state.activeChao] || state.chao[0];
  }

  function getChaoStage(chao) {
    if (chao.xp >= 400) return 4;
    if (chao.xp >= 200) return 3;
    if (chao.xp >= 80)  return 2;
    if (chao.xp >= 20)  return 1;
    return 0;
  }

  const STAGE_NAMES = ['Egg', 'Child', 'Teen', 'Adult', 'Chaos'];

  function getChaoMood(chao) {
    if (chao.happiness >= 60) return 'happy';
    if (chao.happiness >= 30) return 'ok';
    return 'sad';
  }

  let petAnimFrame = 0;
  let petAnimTimer = null;

  // Check and unlock new Chao
  function checkChaoUnlocks() {
    const ownedTypes = state.chao.map(c => c.type);
    CHAO_UNLOCKS.forEach(unlock => {
      if (!ownedTypes.includes(unlock.type) && unlock.check()) {
        const typeInfo = CHAO_TYPES[unlock.type];
        const newChao = createChao(typeInfo.name, unlock.type);
        state.chao.push(newChao);
        save();
        showToast(`New Chao hatched: ${typeInfo.name}!`, 'xp');
        setTimeout(() => showAchievement({
          icon: '\u{1F95A}',
          name: `${typeInfo.name} Chao!`,
          desc: `A new ${typeInfo.name} Chao joined your garden!`
        }), 600);
      }
    });
  }

  function feedPet(action) {
    state.petLastFed = Date.now();
    // Feed ALL chao (they all benefit from your actions)
    state.chao.forEach(chao => {
      chao.lastFed = Date.now();
      switch (action) {
        case 'log':
          chao.happiness = Math.min(100, chao.happiness + 15);
          chao.energy = Math.min(100, chao.energy + 10);
          chao.xp += 5;
          break;
        case 'fast_complete':
          chao.happiness = Math.min(100, chao.happiness + 20);
          chao.energy = Math.min(100, chao.energy + 15);
          chao.xp += 10;
          break;
        case 'achievement':
          chao.happiness = Math.min(100, chao.happiness + 25);
          chao.xp += 15;
          break;
        case 'streak':
          chao.happiness = Math.min(100, chao.happiness + 10);
          chao.xp += 3;
          break;
      }
      // Check for evolution
      const oldStage = chao.stage;
      chao.stage = getChaoStage(chao);
      if (chao.stage > oldStage) {
        showToast(`${chao.name} evolved to ${STAGE_NAMES[chao.stage]}!`, 'xp');
      }
    });
    checkChaoUnlocks();
    save();
  }

  function updatePetStats() {
    state.chao.forEach(chao => {
      const hoursSinceFed = (Date.now() - chao.lastFed) / 3600000;
      const decayRate = Math.min(hoursSinceFed, 72) * (5 / 12);
      chao.happiness = Math.max(0, Math.min(100, chao.happiness - decayRate * 0.01));
      if (currentFast()) {
        chao.energy = Math.max(20, chao.energy - 0.01);
      } else {
        chao.energy = Math.min(100, chao.energy + 0.01);
      }
    });
  }

  function getHoursSinceLastLog() {
    if (state.entries.length === 0) return 999;
    const lastEntry = state.entries[state.entries.length - 1];
    return (Date.now() - lastEntry.ts) / 3600000;
  }

  function getPetMessage() {
    const chao = getActiveChao();
    if (!chao) return '';
    const mood = getChaoMood(chao);
    const stage = chao.stage;
    const hoursSinceLog = getHoursSinceLastLog();
    const fasting = currentFast() !== null;
    const name = chao.name;

    if (hoursSinceLog > 48) return `${name} misses you... please log your weight!`;
    if (hoursSinceLog > 24) return `${name} is waiting for you...`;

    if (mood === 'sad') {
      const msgs = [
        `${name} is feeling lonely...`,
        `${name} needs attention...`,
        `${name} looks droopy...`
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }

    if (fasting) {
      const msgs = [
        `${name} is fasting with you! Stay strong!`,
        `${name} believes in you!`,
        `${name} is cheering you on!`,
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }

    if (mood === 'ok') return `${name} could use some love...`;

    const happyMsgs = [
      [`${name} is cozy in the egg~`, `${name} is wiggling!`, `${name} feels warm...`],
      [`${name} is bouncing happily!`, `${name} loves you!`, `*${name} does a little dance*`],
      [`${name} is getting stronger!`, `${name} is so proud of you!`, `${name} is thriving!`],
      [`${name} flexes confidently!`, `${name}: "We're unstoppable!"`, `${name} sparkles with joy!`],
      [`${name} radiates chaos energy!`, `${name}: "WE ARE CHAMPIONS!"`, `${name} glows with power!`],
    ];
    const msgs = happyMsgs[Math.min(stage, 4)];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  // ===== Drawing Chao =====
  function drawChao(ctx, chao, x, y, scale, frame) {
    const colors = CHAO_TYPES[chao.type] || CHAO_TYPES.neutral;
    const mood = getChaoMood(chao);
    const stage = chao.stage;
    const s = scale;

    const bounce = Math.sin(frame * 0.06 + x) * 2 * s;
    const breathe = Math.sin(frame * 0.03 + x) * 1 * s;
    const cy = y + bounce;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(x, y + 38 * s, 14 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    if (stage === 0) {
      // EGG - speckled oval
      ctx.fillStyle = '#eaeaea';
      ctx.beginPath();
      ctx.ellipse(x, cy, 14 * s, 18 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // Speckles
      ctx.fillStyle = colors.body;
      const spots = [[- 6, -8], [4, -4], [-3, 6], [7, 3], [-8, 1]];
      spots.forEach(([sx, sy]) => {
        ctx.beginPath();
        ctx.arc(x + sx * s, cy + sy * s, 2.5 * s, 0, Math.PI * 2);
        ctx.fill();
      });
      // Crack lines when close to hatching
      if (chao.xp >= 12) {
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 4 * s, cy - 6 * s);
        ctx.lineTo(x, cy - 2 * s);
        ctx.lineTo(x + 3 * s, cy - 7 * s);
        ctx.stroke();
      }
      return;
    }

    // BODY - teardrop/round Chao shape
    const bodyH = (stage >= 3) ? 22 : (stage >= 2) ? 20 : 16;
    const bodyW = (stage >= 3) ? 16 : (stage >= 2) ? 14 : 12;

    // Body
    ctx.fillStyle = colors.body;
    ctx.beginPath();
    ctx.ellipse(x, cy + 4 * s, bodyW * s, bodyH * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Belly
    ctx.fillStyle = colors.belly;
    ctx.beginPath();
    ctx.ellipse(x, cy + 8 * s, bodyW * 0.6 * s, bodyH * 0.55 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // FLOATING BOBBLE (emotiball) above head
    const bobbleY = cy - bodyH * s - 8 * s + Math.sin(frame * 0.1 + x * 0.1) * 3 * s;
    ctx.fillStyle = colors.bobble;
    ctx.beginPath();
    ctx.arc(x, bobbleY, (stage >= 3 ? 5 : stage >= 2 ? 4.5 : 4) * s, 0, Math.PI * 2);
    ctx.fill();
    // Bobble highlight
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(x - 1.5 * s, bobbleY - 1.5 * s, 1.5 * s, 0, Math.PI * 2);
    ctx.fill();

    // WINGS (small for child, bigger for older)
    if (stage >= 1) {
      ctx.fillStyle = colors.highlight;
      const wingSize = (stage >= 3) ? 10 : (stage >= 2) ? 8 : 5;
      const wingFlap = Math.sin(frame * 0.15 + x) * 3 * s;
      // Left wing
      ctx.beginPath();
      ctx.ellipse(x - bodyW * s - 2 * s, cy - 2 * s + wingFlap, wingSize * 0.5 * s, wingSize * s, -0.3, 0, Math.PI * 2);
      ctx.fill();
      // Right wing
      ctx.beginPath();
      ctx.ellipse(x + bodyW * s + 2 * s, cy - 2 * s - wingFlap, wingSize * 0.5 * s, wingSize * s, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // EYES
    const eyeY = cy - 2 * s;
    const eyeSpacing = 5 * s;
    const eyeSize = (stage >= 3) ? 3 : 2.5;
    const blinking = frame % 120 > 115;

    if (blinking && mood !== 'sad') {
      // Blink - horizontal lines
      ctx.strokeStyle = '#1a1a2e';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(x - eyeSpacing - eyeSize * s, eyeY);
      ctx.lineTo(x - eyeSpacing + eyeSize * s, eyeY);
      ctx.moveTo(x + eyeSpacing - eyeSize * s, eyeY);
      ctx.lineTo(x + eyeSpacing + eyeSize * s, eyeY);
      ctx.stroke();
    } else {
      // Normal eyes
      ctx.fillStyle = '#1a1a2e';
      if (mood === 'sad') {
        // Sad droopy eyes (half circles, top)
        ctx.beginPath();
        ctx.arc(x - eyeSpacing, eyeY, eyeSize * s, 0, Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + eyeSpacing, eyeY, eyeSize * s, 0, Math.PI);
        ctx.fill();
      } else if (mood === 'happy') {
        // Happy round eyes with sparkle
        ctx.beginPath();
        ctx.arc(x - eyeSpacing, eyeY, eyeSize * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + eyeSpacing, eyeY, eyeSize * s, 0, Math.PI * 2);
        ctx.fill();
        // Eye sparkle
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x - eyeSpacing + 1 * s, eyeY - 1 * s, 1 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + eyeSpacing + 1 * s, eyeY - 1 * s, 1 * s, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Neutral eyes
        ctx.beginPath();
        ctx.arc(x - eyeSpacing, eyeY, eyeSize * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + eyeSpacing, eyeY, eyeSize * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // MOUTH
    ctx.strokeStyle = mood === 'sad' ? '#e94560' : '#e94560';
    ctx.lineWidth = 1.2 * s;
    ctx.lineCap = 'round';
    if (mood === 'happy') {
      // Happy smile
      ctx.beginPath();
      ctx.arc(x, eyeY + 5 * s, 3 * s, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
    } else if (mood === 'sad') {
      // Sad frown
      ctx.beginPath();
      ctx.arc(x, eyeY + 9 * s, 3 * s, 1.1 * Math.PI, 1.9 * Math.PI);
      ctx.stroke();
    } else {
      // Neutral line
      ctx.beginPath();
      ctx.moveTo(x - 2 * s, eyeY + 6 * s);
      ctx.lineTo(x + 2 * s, eyeY + 6 * s);
      ctx.stroke();
    }

    // FEET (little nubs at bottom)
    ctx.fillStyle = colors.body;
    ctx.beginPath();
    ctx.ellipse(x - 5 * s, cy + bodyH * s - 2 * s, 4 * s, 2.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + 5 * s, cy + bodyH * s - 2 * s, 4 * s, 2.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // HANDS (little round nubs on sides)
    if (stage >= 2) {
      ctx.fillStyle = colors.highlight;
      ctx.beginPath();
      ctx.arc(x - bodyW * s + 1 * s, cy + 10 * s, 3 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + bodyW * s - 1 * s, cy + 10 * s, 3 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stage 4 (Chaos) - glowing aura
    if (stage >= 4) {
      ctx.strokeStyle = colors.bobble;
      ctx.lineWidth = 1.5 * s;
      ctx.globalAlpha = 0.2 + Math.sin(frame * 0.08) * 0.15;
      ctx.beginPath();
      ctx.ellipse(x, cy + 4 * s, (bodyW + 6) * s, (bodyH + 6) * s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Mood particles
    if (mood === 'happy' && frame % 40 < 8) {
      ctx.fillStyle = colors.bobble;
      const px1 = x - 20 * s + Math.sin(frame * 0.2) * 10 * s;
      const py1 = cy - 20 * s - (frame % 40) * s;
      ctx.fillRect(px1, py1, 2 * s, 2 * s);
      ctx.fillRect(px1 + 25 * s, py1 + 5 * s, 2 * s, 2 * s);
    }

    if (mood === 'sad' && frame % 60 < 30) {
      ctx.fillStyle = '#00d2ff';
      const tearY2 = eyeY + 4 * s + (frame % 60) * 1 * s;
      ctx.beginPath();
      ctx.ellipse(x - eyeSpacing, tearY2, 1 * s, 1.5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sleeping Z's
    if (chao.energy < 30) {
      ctx.fillStyle = '#9a9ab0';
      ctx.font = `bold ${9 * s}px monospace`;
      ctx.fillText('z', x + 15 * s + Math.sin(frame * 0.03) * 3 * s, cy - 20 * s + bounce);
      ctx.font = `bold ${7 * s}px monospace`;
      ctx.fillText('z', x + 22 * s, cy - 28 * s + bounce);
    }
  }

  // ===== Tap to pet =====
  let heartParticles = [];
  let lastPetTime = 0;

  function handlePetChao(e) {
    const now = Date.now();
    // Rate limit: once per 500ms
    if (now - lastPetTime < 500) return;
    lastPetTime = now;

    const canvas = $('#pet-canvas');
    const rect = canvas.getBoundingClientRect();
    const tapX = (e.clientX || e.pageX) - rect.left;
    const tapY = (e.clientY || e.pageY) - rect.top;

    // Spawn heart particles at tap location
    for (let i = 0; i < 3; i++) {
      heartParticles.push({
        x: tapX + (Math.random() - 0.5) * 30,
        y: tapY,
        vx: (Math.random() - 0.5) * 2,
        vy: -1.5 - Math.random() * 2,
        life: 40 + Math.random() * 20,
        maxLife: 40 + Math.random() * 20,
        size: 6 + Math.random() * 4,
      });
    }

    // Boost active chao happiness a small amount
    const chao = getActiveChao();
    if (chao) {
      chao.happiness = Math.min(100, chao.happiness + 2);
      chao.lastFed = Date.now();
      state.petLastFed = Date.now();
      save();
      renderPet();
    }
  }

  function drawHearts(ctx) {
    heartParticles = heartParticles.filter(p => p.life > 0);
    heartParticles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02; // slight gravity
      p.life--;
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e94560';
      drawHeart(ctx, p.x, p.y, p.size);
      ctx.globalAlpha = 1;
    });
  }

  function drawHeart(ctx, x, y, size) {
    const s = size / 10;
    ctx.beginPath();
    ctx.moveTo(x, y + 3 * s);
    ctx.bezierCurveTo(x, y, x - 5 * s, y, x - 5 * s, y + 3 * s);
    ctx.bezierCurveTo(x - 5 * s, y + 6 * s, x, y + 9 * s, x, y + 10 * s);
    ctx.bezierCurveTo(x, y + 9 * s, x + 5 * s, y + 6 * s, x + 5 * s, y + 3 * s);
    ctx.bezierCurveTo(x + 5 * s, y, x, y, x, y + 3 * s);
    ctx.fill();
  }

  function drawGarden() {
    const canvas = $('#pet-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);
    petAnimFrame++;

    // Garden background - subtle grass
    const grassGrad = ctx.createLinearGradient(0, h * 0.7, 0, h);
    grassGrad.addColorStop(0, 'rgba(0, 80, 40, 0.15)');
    grassGrad.addColorStop(1, 'rgba(0, 60, 30, 0.25)');
    ctx.fillStyle = grassGrad;
    ctx.beginPath();
    ctx.ellipse(w / 2, h + 10, w * 0.6, h * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw each chao
    const chaoCount = state.chao.length;
    if (chaoCount === 0) return;

    if (chaoCount === 1) {
      drawChao(ctx, state.chao[0], w / 2, h * 0.42, 2, petAnimFrame);
      drawHearts(ctx);
    } else {
      // Spread chao across garden
      const positions = [];
      const spacing = Math.min(w / (chaoCount + 1), 80);
      const startX = (w - spacing * (chaoCount - 1)) / 2;
      for (let i = 0; i < chaoCount; i++) {
        const px = startX + i * spacing;
        const py = h * 0.42 + Math.sin(i * 1.5) * 10;
        const sc = chaoCount <= 3 ? 1.6 : chaoCount <= 5 ? 1.3 : 1;
        positions.push({ x: px, y: py, scale: sc });
      }

      // Draw active chao last (on top) and slightly bigger
      const order = state.chao.map((c, i) => i).sort((a, b) => {
        if (a === state.activeChao) return 1;
        if (b === state.activeChao) return -1;
        return 0;
      });

      order.forEach(i => {
        const isActive = i === state.activeChao;
        const pos = positions[i];
        const sc = isActive ? pos.scale * 1.15 : pos.scale;

        // Highlight ring for active chao
        if (isActive) {
          ctx.strokeStyle = 'rgba(255, 214, 0, 0.3)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(pos.x, pos.y + 38 * sc, 18 * sc, 5 * sc, 0, 0, Math.PI * 2);
          ctx.stroke();
        }

        drawChao(ctx, state.chao[i], pos.x, pos.y, sc, petAnimFrame + i * 20);
      });
    }

    // Draw heart particles on top
    drawHearts(ctx);
  }

  function renderChaoSelector() {
    const sel = $('#chao-selector');
    if (state.chao.length <= 1) {
      sel.innerHTML = '';
      return;
    }
    sel.innerHTML = state.chao.map((chao, i) => {
      const colors = CHAO_TYPES[chao.type] || CHAO_TYPES.neutral;
      const active = i === state.activeChao;
      return `<button class="chao-tab${active ? ' active' : ''}" data-idx="${i}"
        style="--chao-color: ${colors.body}" title="${chao.name}">
        <span class="chao-tab-dot" style="background:${colors.body}"></span>
        <span class="chao-tab-name">${chao.name}</span>
      </button>`;
    }).join('');

    sel.querySelectorAll('.chao-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeChao = parseInt(btn.dataset.idx);
        save();
        renderPet();
      });
    });
  }

  function renderPet() {
    // Migrate old single-pet state
    if ((!state.chao || state.chao.length === 0) && state.onboarded) {
      state.chao = [createChao(state.petName || 'Buddy', 'neutral')];
      state.activeChao = 0;
      save();
    }

    updatePetStats();
    checkChaoUnlocks();
    const chao = getActiveChao();
    if (!chao) return;

    const mood = getChaoMood(chao);
    const moodLabel = $('#pet-mood-label');
    moodLabel.textContent = mood === 'happy' ? 'Happy' : mood === 'ok' ? 'Meh' : 'Sad';
    moodLabel.className = `pet-mood ${mood === 'happy' ? '' : mood}`;

    const typeInfo = CHAO_TYPES[chao.type] || CHAO_TYPES.neutral;
    $('#pet-name').textContent = chao.name;
    $('#chao-type-label').textContent = `${typeInfo.name} Chao`;
    $('#pet-message').textContent = getPetMessage();
    $('#pet-evolution').textContent = `${STAGE_NAMES[chao.stage]} \u2022 Stage ${chao.stage + 1}/5 \u2022 ${chao.xp} CXP`;

    // Unlock hint
    const hint = $('#chao-unlock-hint');
    const nextUnlock = CHAO_UNLOCKS.find(u => !state.chao.some(c => c.type === u.type));
    hint.textContent = nextUnlock
      ? `Next Chao: ${nextUnlock.desc}`
      : `All ${state.chao.length} Chao unlocked!`;

    // Bars (active chao)
    const hBar = $('#pet-happiness-bar');
    const eBar = $('#pet-energy-bar');
    hBar.style.width = `${chao.happiness}%`;
    eBar.style.width = `${chao.energy}%`;
    hBar.className = `pet-bar-fill happiness-fill${chao.happiness < 30 ? ' low' : chao.happiness < 60 ? ' mid' : ''}`;
    eBar.className = `pet-bar-fill energy-fill${chao.energy < 30 ? ' low' : chao.energy < 60 ? ' mid' : ''}`;

    renderChaoSelector();
    drawGarden();
  }

  function startPetAnimation() {
    if (petAnimTimer) return;
    petAnimTimer = setInterval(drawGarden, 1000 / 15);
  }

  function stopPetAnimation() {
    if (petAnimTimer) {
      clearInterval(petAnimTimer);
      petAnimTimer = null;
    }
  }

  // ===== Resize handler for chart =====
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const activeRange = document.querySelector('.range-btn.active');
      if (activeRange) renderChart(activeRange.dataset.range);
    }, 200);
  });

  // ===== Start =====
  document.addEventListener('DOMContentLoaded', init);

})();
