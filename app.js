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
    petName: 'Buddy',
    petHappiness: 80,
    petEnergy: 80,
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
    state.petName = petName || 'Buddy';
    state.petHappiness = 80;
    state.petEnergy = 80;
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
      state.entries[existing].weight = weight;
      state.entries[existing].ts = Date.now();
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
      return `
        <div class="history-item">
          <div class="history-date">${dateFormatted}</div>
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
    $('#settings-pet-name').value = state.petName;
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
    state.petName = $('#settings-pet-name').value.trim() || 'Buddy';
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

  // ===== Toast =====
  function showToast(message, type = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  // ===== Pixel Pet System =====
  // 5 evolution stages based on level: Egg, Baby, Kid, Teen, Champion
  // Each stage is a pixel art sprite drawn on canvas

  const PET_SPRITES = {
    // Each sprite is a grid of hex colors (null = transparent)
    // 16x16 pixel art, scaled up on canvas
    egg: [
      '................',
      '......GGGG......',
      '....GGWWWWGG....',
      '...GWWWWWWWWG...',
      '..GWWWWWWWWWWG..',
      '..GWWPPWWPPWWG..',
      '..GWWWWWWWWWWG..',
      '..GWWWPPPPWWWG..',
      '..GWWWWWWWWWWG..',
      '...GWWWWWWWWG...',
      '...GGWWWWWWGG...',
      '....GGGGGGGG....',
      '................',
      '................',
      '................',
      '................',
    ],
    baby: [
      '................',
      '......CCCC......',
      '....CCCCCCCC....',
      '...CCCCCCCCCC...',
      '..CCCCCCCCCCCC..',
      '..CC.EE..EE.CC..',
      '..CCCCCCCCCCCC..',
      '..CCC.PPPP.CCC..',
      '..CCCCCCCCCCCC..',
      '...CCCCCCCCCC...',
      '....CCCCCCCC....',
      '....CC....CC....',
      '...CCC....CCC...',
      '................',
      '................',
      '................',
    ],
    kid: [
      '....CCCCCCCC....',
      '..CCCCCCCCCCCC..',
      '..CCCCCCCCCCCC..',
      '.CCC.EE..EE.CCC.',
      '.CCCCCCCCCCCCCC.',
      '.CCC..PPPP..CCC.',
      '.CCCCCCCCCCCCCC.',
      '..CCCCCCCCCCCC..',
      '....FFFFFFFF....',
      '...FFFFFFFFFF...',
      '...FFFFFFFFFF...',
      '...FF.FFFF.FF...',
      '...FF.FFFF.FF...',
      '..CC..FFFF..CC..',
      '..CCC......CCC..',
      '................',
    ],
    teen: [
      '...AACCCCCCAA...',
      '..AACCCCCCCCAA..',
      '..CCCCCCCCCCCC..',
      '.CCC.EE..EE.CCC.',
      '.CCCCEEYYEECCCC.',
      '.CCC..PPPP..CCC.',
      '.CCCCCCCCCCCCCC.',
      '..CCCCCCCCCCCC..',
      '...FFFFFFFFFFF..',
      '..FFFFFFFFFFFF..',
      '..FFFFFFFFFFFF..',
      '..FF..FFFF..FF..',
      '..FF..FFFF..FF..',
      '.CCC..FFFF..CCC.',
      '.CCC........CCC.',
      '................',
    ],
    champion: [
      '....YY....YY....',
      '...YYYYYYYYYY...',
      '....YYYYYYYY....',
      '..CCCCCCCCCCCC..',
      '.CCCCCCCCCCCCCC.',
      '.CCC.EE..EE.CCC.',
      '.CCCCEEYYEECCCC.',
      '.CCC.MPPPM.CCC.',
      '.CCCCCCCCCCCCCC.',
      '..CCCCCCCCCCCC..',
      '..RRFFFFFFFFRR..',
      '..RFFFFFFFFFFF..',
      '..FF..FFFF..FF..',
      '..FF..FFFF..FF..',
      '.CCC..FFFF..CCC.',
      '.CCC........CCC.',
    ],
  };

  // Sad variants - droop features
  const PET_SPRITES_SAD = {
    egg: [
      '................',
      '......GGGG......',
      '....GGGGGGGG....',
      '...GGGGGGGGGG...',
      '..GGGGGGGGGGGG..',
      '..GG.EE..EE.GG..',
      '..GGGGGGGGGGGG..',
      '..GGGGGGGGGGGG..',
      '..GGG.PPPP.GGG..',
      '...GGGGGGGGGG...',
      '...GGGGGGGGGG...',
      '....GGGGGGGG....',
      '................',
      '................',
      '................',
      '................',
    ],
    baby: [
      '................',
      '......DDDDDD....',
      '....DDDDDDDD....',
      '...DDDDDDDDDD..',
      '..DDDDDDDDDDDD.',
      '..DD.EE..EE.DD..',
      '..DDDDDDDDDDDD.',
      '..DDDDDDDDDDDD.',
      '..DDD.PPPP.DDD..',
      '...DDDDDDDDDD..',
      '....DDDDDDDD....',
      '....DD....DD....',
      '...DDD....DDD...',
      '................',
      '................',
      '................',
    ],
  };

  const SPRITE_COLORS = {
    'C': '#5bc0eb', // body cyan
    'E': '#1a1a2e', // eyes dark
    'P': '#e94560', // mouth/cheeks
    'G': '#9a9ab0', // egg grey
    'W': '#eaeaea', // egg white
    'F': '#7b2ff7', // clothes purple
    'Y': '#ffd600', // crown/sparkle yellow
    'A': '#00d2ff', // accessories accent
    'R': '#e94560', // cape red
    'M': '#eaeaea', // mouth smile white
    'D': '#6a6a8a', // sad body
    '.': null,       // transparent
  };

  let petAnimFrame = 0;
  let petBounceY = 0;
  let petAnimTimer = null;

  function getPetStage() {
    const lvl = state.level;
    if (lvl >= 10) return 'champion';
    if (lvl >= 7) return 'teen';
    if (lvl >= 4) return 'kid';
    if (lvl >= 2) return 'baby';
    return 'egg';
  }

  function getPetStageNum() {
    const s = getPetStage();
    return { egg: 1, baby: 2, kid: 3, teen: 4, champion: 5 }[s];
  }

  function getPetMood() {
    const h = state.petHappiness;
    if (h >= 60) return 'happy';
    if (h >= 30) return 'ok';
    return 'sad';
  }

  function getPetMessage() {
    const mood = getPetMood();
    const stage = getPetStage();
    const hoursSinceLog = getHoursSinceLastLog();
    const fasting = currentFast() !== null;

    if (hoursSinceLog > 48) return "I miss you... please log your weight!";
    if (hoursSinceLog > 24) return "It's been a while... come say hi?";

    if (mood === 'sad') {
      const sadMsgs = [
        "I'm feeling down... log your weight to cheer me up!",
        "I need attention... track something for me?",
        "Don't forget about me..."
      ];
      return sadMsgs[Math.floor(Math.random() * sadMsgs.length)];
    }

    if (fasting) {
      const fastMsgs = [
        "We're fasting together! Stay strong!",
        "Almost there... I believe in you!",
        "Fasting buddies forever!",
      ];
      return fastMsgs[Math.floor(Math.random() * fastMsgs.length)];
    }

    if (mood === 'ok') {
      return "I could use some more attention...";
    }

    const happyMsgs = {
      egg: ["I'm hatching soon! Keep logging!", "Warm and cozy in here~", "I can feel myself growing!"],
      baby: ["Goo goo! You're doing great!", "I love when you check in!", "*happy wiggles*"],
      kid: ["Let's crush our goals today!", "You're my favorite human!", "We make a great team!"],
      teen: ["Looking strong! Keep it up!", "I'm so proud of your progress!", "We're unstoppable!"],
      champion: ["WE'RE CHAMPIONS! Nothing can stop us!", "Look how far we've come!", "You're an inspiration!"],
    };
    const msgs = happyMsgs[stage];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  function getHoursSinceLastLog() {
    if (state.entries.length === 0) return 999;
    const lastEntry = state.entries[state.entries.length - 1];
    return (Date.now() - lastEntry.ts) / 3600000;
  }

  function updatePetStats() {
    // Decay happiness and energy over time
    const hoursSinceLog = getHoursSinceLastLog();
    const hoursSinceFed = state.petLastFed
      ? (Date.now() - state.petLastFed) / 3600000
      : 999;

    // Slow decay: lose ~5 happiness per 12 hours of no interaction
    const decayRate = Math.min(hoursSinceFed, 72) * (5 / 12);
    state.petHappiness = Math.max(0, Math.min(100, state.petHappiness - decayRate * 0.01));

    // Energy tied to fasting
    if (currentFast()) {
      state.petEnergy = Math.max(20, state.petEnergy - 0.01);
    } else {
      state.petEnergy = Math.min(100, state.petEnergy + 0.01);
    }
  }

  function feedPet(action) {
    // Called when user interacts (logs weight, completes fast, etc.)
    state.petLastFed = Date.now();
    switch (action) {
      case 'log':
        state.petHappiness = Math.min(100, state.petHappiness + 15);
        state.petEnergy = Math.min(100, state.petEnergy + 10);
        break;
      case 'fast_complete':
        state.petHappiness = Math.min(100, state.petHappiness + 20);
        state.petEnergy = Math.min(100, state.petEnergy + 15);
        break;
      case 'achievement':
        state.petHappiness = Math.min(100, state.petHappiness + 25);
        break;
      case 'streak':
        state.petHappiness = Math.min(100, state.petHappiness + 10);
        break;
    }
    save();
  }

  function drawPet() {
    const canvas = $('#pet-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const mood = getPetMood();
    const stage = getPetStage();

    // Pick sprite - use sad variant if available and mood is sad
    let sprite;
    if (mood === 'sad' && PET_SPRITES_SAD[stage]) {
      sprite = PET_SPRITES_SAD[stage];
    } else {
      sprite = PET_SPRITES[stage];
    }

    const size = 160;
    const px = size / 16; // 10px per pixel
    ctx.clearRect(0, 0, size, size);

    // Bounce animation
    petAnimFrame++;
    const bounce = Math.sin(petAnimFrame * 0.08) * 3;
    const breathe = Math.sin(petAnimFrame * 0.04) * 1;

    // Draw pixel grid
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < sprite[row].length; col++) {
        const ch = sprite[row][col];
        const color = SPRITE_COLORS[ch];
        if (!color) continue;

        ctx.fillStyle = color;
        const x = col * px;
        const y = row * px + bounce;

        // Slight scale for breathing
        ctx.fillRect(x, y + breathe, px, px);
      }
    }

    // Draw eyes blinking occasionally
    if (petAnimFrame % 120 > 115 && mood !== 'sad') {
      // Blink: draw skin color over eyes
      const bodyColor = mood === 'sad' ? '#6a6a8a' : '#5bc0eb';
      for (let row = 0; row < 16; row++) {
        for (let col = 0; col < sprite[row].length; col++) {
          if (sprite[row][col] === 'E') {
            ctx.fillStyle = bodyColor;
            ctx.fillRect(col * px, row * px + bounce + breathe, px, px);
          }
        }
      }
    }

    // Draw mood particles
    if (mood === 'happy' && petAnimFrame % 30 < 5) {
      // Sparkles
      ctx.fillStyle = '#ffd600';
      const sparkX = 20 + Math.sin(petAnimFrame * 0.2) * 40;
      const sparkY = 20 + Math.cos(petAnimFrame * 0.15) * 20;
      ctx.fillRect(sparkX, sparkY + bounce, 3, 3);
      ctx.fillRect(sparkX + 60, sparkY + 10 + bounce, 3, 3);
    }

    if (mood === 'sad') {
      // Tear drops
      if (petAnimFrame % 60 < 30) {
        ctx.fillStyle = '#00d2ff';
        const tearY = 70 + (petAnimFrame % 60) * 1.5;
        ctx.fillRect(45, tearY + bounce, 3, 4);
      }
    }

    // Z's for sleeping (low energy)
    if (state.petEnergy < 30) {
      ctx.fillStyle = var_text2Color();
      ctx.font = `bold ${10 + Math.sin(petAnimFrame * 0.05) * 2}px monospace`;
      ctx.fillText('z', 125 + Math.sin(petAnimFrame * 0.03) * 5, 40 + bounce);
      ctx.font = `bold ${8}px monospace`;
      ctx.fillText('z', 135, 30 + bounce);
    }
  }

  function var_text2Color() { return '#9a9ab0'; }

  function renderPet() {
    updatePetStats();

    const mood = getPetMood();
    const moodLabel = $('#pet-mood-label');
    moodLabel.textContent = mood === 'happy' ? 'Happy' : mood === 'ok' ? 'Meh' : 'Sad';
    moodLabel.className = `pet-mood ${mood === 'happy' ? '' : mood}`;

    $('#pet-name').textContent = state.petName;
    $('#pet-message').textContent = getPetMessage();
    $('#pet-evolution').textContent = `Stage ${getPetStageNum()} / 5 — ${getPetStage().charAt(0).toUpperCase() + getPetStage().slice(1)}`;

    // Bars
    const hBar = $('#pet-happiness-bar');
    const eBar = $('#pet-energy-bar');
    hBar.style.width = `${state.petHappiness}%`;
    eBar.style.width = `${state.petEnergy}%`;
    hBar.className = `pet-bar-fill happiness-fill${state.petHappiness < 30 ? ' low' : state.petHappiness < 60 ? ' mid' : ''}`;
    eBar.className = `pet-bar-fill energy-fill${state.petEnergy < 30 ? ' low' : state.petEnergy < 60 ? ' mid' : ''}`;

    drawPet();
  }

  function startPetAnimation() {
    if (petAnimTimer) return;
    petAnimTimer = setInterval(() => {
      drawPet();
    }, 1000 / 15); // 15fps for that retro feel
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
