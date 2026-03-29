// ========== GitSlim - Weight Tracking App ==========

(function () {
  'use strict';

  // ===== Firebase Config =====
  // Firestore Rules (paste in Firebase Console > Firestore > Rules):
  //   rules_version = '2';
  //   service cloud.firestore {
  //     match /databases/{database}/documents {
  //       match /users/{userId} {
  //         allow read, write: if request.auth != null && request.auth.uid == userId;
  //       }
  //     }
  //   }
  const firebaseConfig = {
    apiKey: "AIzaSyD4-fqwrA3IwgU0HYbaFc-c2TrtEI11WQo",
    authDomain: "gitslim.firebaseapp.com",
    projectId: "gitslim",
    storageBucket: "gitslim.firebasestorage.app",
    messagingSenderId: "53316050274",
    appId: "1:53316050274:web:c0a8d1ddb0dae5ed26203b"
  };

  let firebaseApp = null;
  let auth = null;
  let db = null;
  let currentUser = null;
  let cloudSyncEnabled = false;
  let syncDebounceTimer = null;

  // Initialize Firebase
  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') return false;
      firebaseApp = firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db = firebase.firestore();
      return true;
    } catch (e) {
      console.warn('Firebase init failed:', e.message);
      return false;
    }
  }

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
    rings: 0,            // spendable currency (earned alongside XP)
    inventory: [],       // purchased accessory IDs
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
    // Debounced cloud sync
    if (cloudSyncEnabled && currentUser) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => saveToCloud(), 1500);
    }
  }

  // ===== Cloud Save/Load =====
  function saveToCloud() {
    if (!db || !currentUser) return;
    const syncBtn = document.querySelector('#sync-status-btn');
    if (syncBtn) {
      syncBtn.textContent = '\u2601 Saving...';
      syncBtn.classList.remove('hidden');
    }
    db.collection('users').doc(currentUser.uid).set({
      state: JSON.stringify(state),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      email: currentUser.email,
    }).then(() => {
      if (syncBtn) syncBtn.textContent = '\u2601 Synced';
    }).catch((err) => {
      console.error('Cloud save failed:', err);
      if (syncBtn) syncBtn.textContent = '\u2601 Offline';
      // Show error on first failure so user knows what to fix
      if (err.code === 'permission-denied') {
        showToast('Cloud save blocked — update Firestore rules', 'error');
      }
    });
  }

  function loadFromCloud() {
    if (!db || !currentUser) return Promise.resolve(null);
    return db.collection('users').doc(currentUser.uid).get().then(doc => {
      if (doc.exists && doc.data().state) {
        return JSON.parse(doc.data().state);
      }
      return null;
    }).catch(err => {
      console.error('Cloud load failed:', err);
      return null;
    });
  }

  // Merge cloud data with local: keeps whichever has more entries / higher XP
  function mergeStates(local, cloud) {
    if (!cloud) return local;
    if (!local.onboarded && cloud.onboarded) return { ...defaults, ...cloud };
    if (local.onboarded && !cloud.onboarded) return local;

    // Both onboarded — merge entries by date, keep the one with more progress
    const merged = { ...local };

    // Merge weight entries (union by date+ts)
    const entryMap = new Map();
    local.entries.forEach(e => entryMap.set(e.date + '_' + (e.ts || 0), e));
    cloud.entries.forEach(e => {
      const key = e.date + '_' + (e.ts || 0);
      if (!entryMap.has(key)) entryMap.set(key, e);
    });
    merged.entries = Array.from(entryMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0)
    );

    // Keep higher XP/level/rings
    merged.xp = Math.max(local.xp || 0, cloud.xp || 0);
    merged.level = Math.max(local.level || 1, cloud.level || 1);
    merged.rings = Math.max(local.rings || 0, cloud.rings || 0);

    // Merge achievements (union)
    const achSet = new Set([...(local.achievements || []), ...(cloud.achievements || [])]);
    merged.achievements = Array.from(achSet);

    // Merge fasts (union by start timestamp)
    const fastMap = new Map();
    (local.fasts || []).forEach(f => fastMap.set(f.start, f));
    (cloud.fasts || []).forEach(f => {
      if (!fastMap.has(f.start)) fastMap.set(f.start, f);
    });
    merged.fasts = Array.from(fastMap.values()).sort((a, b) => a.start - b.start);

    // Keep whichever has more chao
    if ((cloud.chao || []).length > (local.chao || []).length) {
      merged.chao = cloud.chao;
    }

    // Keep whichever has more inventory items
    const invSet = new Set([...(local.inventory || []), ...(cloud.inventory || [])]);
    merged.inventory = Array.from(invSet);

    // Use cloud profile if local name is default
    if (local.name === 'Friend' && cloud.name && cloud.name !== 'Friend') {
      merged.name = cloud.name;
    }

    return merged;
  }

  // ===== Auth Flow =====
  function handleGoogleSignIn() {
    if (!auth) {
      showToast('Sign-in not available', 'error');
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => {
      console.error('Sign-in error:', err);
      if (err.code !== 'auth/popup-closed-by-user') {
        showToast('Sign-in failed: ' + err.message, 'error');
      }
    });
  }

  function handleSignOut() {
    if (!auth) return;
    // Save to cloud first
    if (cloudSyncEnabled && currentUser) {
      saveToCloud();
    }
    auth.signOut().then(() => {
      currentUser = null;
      cloudSyncEnabled = false;
      updateAuthUI();
      showToast('Signed out', 'success');
    });
  }

  let hasCompletedInitialSync = false;

  function onAuthStateChanged(user) {
    currentUser = user;
    if (user) {
      cloudSyncEnabled = true;
      // Only merge on the first auth callback to avoid overwriting fresh local data
      if (hasCompletedInitialSync) {
        updateAuthUI();
        return;
      }
      hasCompletedInitialSync = true;
      // Load from cloud and merge with local
      loadFromCloud().then(cloudState => {
        if (cloudState) {
          state = mergeStates(state, cloudState);
          save(); // saves merged to local + triggers cloud sync
        } else if (state.onboarded) {
          // First time cloud save — push local to cloud
          saveToCloud();
        }
        updateAuthUI();
        // If already onboarded, refresh dashboard
        if (state.onboarded) {
          showScreen('dashboard');
          renderDashboard();
        } else {
          showScreen('onboarding');
        }
      });
    } else {
      cloudSyncEnabled = false;
      hasCompletedInitialSync = false;
      updateAuthUI();
    }
  }

  function updateAuthUI() {
    const syncBtn = document.querySelector('#sync-status-btn');
    const settingsStatus = document.querySelector('#settings-auth-status');
    const settingsSignin = document.querySelector('#settings-signin-btn');
    const settingsSignout = document.querySelector('#settings-signout-btn');

    if (currentUser) {
      if (syncBtn) {
        syncBtn.classList.remove('hidden');
        syncBtn.textContent = '\u2601 Synced';
      }
      if (settingsStatus) settingsStatus.textContent = currentUser.email;
      if (settingsSignin) settingsSignin.classList.add('hidden');
      if (settingsSignout) settingsSignout.classList.remove('hidden');
    } else {
      if (syncBtn) syncBtn.classList.add('hidden');
      if (settingsStatus) settingsStatus.textContent = 'Not signed in (data stored locally)';
      if (settingsSignin) settingsSignin.classList.remove('hidden');
      if (settingsSignout) settingsSignout.classList.add('hidden');
    }
  }

  // ===== DOM Refs =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ===== Init =====
  function init() {
    const firebaseReady = initFirebase();

    if (firebaseReady && auth) {
      // Listen for auth state changes
      auth.onAuthStateChanged(onAuthStateChanged);

      // Show auth screen if not onboarded and not already signed in
      if (!state.onboarded) {
        showScreen('auth-screen');
      } else {
        showScreen('dashboard');
        renderDashboard();
      }
    } else {
      // Firebase not available — fallback to local-only
      if (!state.onboarded) {
        showScreen('onboarding');
      } else {
        showScreen('dashboard');
        renderDashboard();
      }
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
    // Auth screen
    const googleBtn = $('#google-signin-btn');
    if (googleBtn) googleBtn.addEventListener('click', handleGoogleSignIn);
    const skipBtn = $('#skip-auth-btn');
    if (skipBtn) skipBtn.addEventListener('click', () => {
      showScreen('onboarding');
    });

    // Settings auth buttons
    const settingsSignin = $('#settings-signin-btn');
    if (settingsSignin) settingsSignin.addEventListener('click', handleGoogleSignIn);
    const settingsSignout = $('#settings-signout-btn');
    if (settingsSignout) settingsSignout.addEventListener('click', handleSignOut);

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
    $('#samsung-import-btn').addEventListener('click', () => $('#samsung-import-file').click());
    $('#samsung-import-file').addEventListener('change', importSamsungHealth);

    // Reset
    $('#reset-btn').addEventListener('click', handleReset);

    // Shop
    $('#shop-btn').addEventListener('click', openShop);
    $('#shop-close').addEventListener('click', () => $('#shop-modal').classList.add('hidden'));
    $$('.shop-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.shop-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderShopGrid(btn.dataset.cat);
      });
    });

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

    const petName = ($('#onboard-pet-name').value || '').trim() || 'Buddy';
    state.name = name || 'Friend';
    state.unit = unit;
    state.goalWeight = goal;
    state.heightIn = ft * 12 + inches;
    state.petName = petName; // persist for migration fallback
    state.chao = [createChao(petName, 'neutral')];
    state.activeChao = 0;
    state.petLastFed = Date.now();
    state.onboarded = true;

    // Log first entry
    addEntry(weight);
    addXP(50, 'Welcome bonus!');

    save();
    // Force immediate cloud save (don't rely on debounce for first save)
    if (cloudSyncEnabled && currentUser) {
      saveToCloud();
    }
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

    addEntry(weight);

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
    // Award rings alongside XP
    const ringAmount = Math.max(1, Math.round(amount / 2));
    state.rings = (state.rings || 0) + ringAmount;
    const newLevel = Math.floor(state.xp / 100) + 1;
    if (newLevel > state.level) {
      state.level = newLevel;
      setTimeout(() => showToast(`Level up! You're now Level ${newLevel}`, 'xp'), 800);
    }
    save();
    if (reason) {
      showToast(`+${amount} XP, +${ringAmount} rings - ${reason}`, 'xp');
    }
  }

  // ===== Accessories =====
  const ACCESSORIES = [
    // Hats
    { id: 'bow', name: 'Bow', category: 'hat', price: 30, desc: 'A cute little bow' },
    { id: 'party_hat', name: 'Party Hat', category: 'hat', price: 50, desc: 'Time to celebrate!' },
    { id: 'crown', name: 'Crown', category: 'hat', price: 150, desc: 'Royalty vibes' },
    { id: 'top_hat', name: 'Top Hat', category: 'hat', price: 100, desc: 'Fancy and dapper' },
    { id: 'halo', name: 'Halo', category: 'hat', price: 200, desc: 'An angelic ring' },
    // Face
    { id: 'sunglasses', name: 'Sunglasses', category: 'face', price: 60, desc: 'Too cool for school' },
    { id: 'round_glasses', name: 'Glasses', category: 'face', price: 40, desc: 'Scholarly look' },
    // Neck
    { id: 'bowtie', name: 'Bowtie', category: 'neck', price: 45, desc: 'Dashing!' },
    { id: 'scarf', name: 'Scarf', category: 'neck', price: 70, desc: 'Cozy and warm' },
    { id: 'cape', name: 'Cape', category: 'neck', price: 120, desc: 'Superhero mode' },
    // Special
    { id: 'devil_horns', name: 'Devil Horns', category: 'hat', price: 175, desc: 'A little mischievous' },
    { id: 'flower', name: 'Flower', category: 'hat', price: 35, desc: 'A daisy on top' },
  ];

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
  // Automatic daily fasting: starts at fastStartHour, ends at fastEndHour next day
  function getFastingWindow() {
    const now = new Date();
    const startHour = state.fastStartHour; // e.g. 20 (8pm)
    const endHour = state.fastEndHour;     // e.g. 13 (1pm)

    // Today's fast start
    const todayStart = new Date(now);
    todayStart.setHours(startHour, 0, 0, 0);

    // Yesterday's fast start
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    // End time is endHour on the day after start
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    todayEnd.setHours(endHour, 0, 0, 0);

    const yesterdayEnd = new Date(yesterdayStart);
    yesterdayEnd.setDate(yesterdayEnd.getDate() + 1);
    yesterdayEnd.setHours(endHour, 0, 0, 0);

    // Are we in yesterday's fasting window? (e.g. 8pm yesterday to 1pm today)
    if (now >= yesterdayStart && now < yesterdayEnd) {
      return { start: yesterdayStart, end: yesterdayEnd };
    }
    // Are we in today's fasting window? (e.g. 8pm today onward)
    if (now >= todayStart && now < todayEnd) {
      return { start: todayStart, end: todayEnd };
    }
    // Eating window — show next fast start
    return { start: todayStart, end: todayEnd, eating: true };
  }

  function getRequiredFastHours() {
    let hours = state.fastEndHour - state.fastStartHour;
    if (hours <= 0) hours += 24;
    return hours;
  }

  // Returns true if currently in a fasting window
  function currentFast() {
    const win = getFastingWindow();
    return win.eating ? null : win;
  }

  // Returns count of completed fasts
  function completedFasts() {
    return (state.fasts || []).filter(f => f.end).length;
  }

  function startFastingTicker() {
    setInterval(renderFastingTimer, 1000);
  }

  function renderFastingTimer() {
    const ring = $('#fasting-ring-progress');
    const timeEl = $('#fasting-time');
    const labelEl = $('#fasting-label');
    const win = getFastingWindow();
    const now = Date.now();

    if (win.eating) {
      // In eating window — countdown to next fast
      const untilFast = (win.start.getTime() - now) / 1000;
      const h = Math.floor(untilFast / 3600);
      const m = Math.floor((untilFast % 3600) / 60);
      ring.style.strokeDashoffset = 339.292;
      ring.style.stroke = 'var(--green)';
      timeEl.textContent = `${h}h ${m.toString().padStart(2, '0')}m`;
      labelEl.textContent = 'eating window';
      return;
    }

    // In fasting window
    const total = (win.end.getTime() - win.start.getTime()) / 1000;
    const elapsed = (now - win.start.getTime()) / 1000;
    const remaining = Math.max(0, total - elapsed);
    const progress = Math.min(elapsed / total, 1);

    ring.style.strokeDashoffset = 339.292 * (1 - progress);

    if (remaining > 0) {
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      timeEl.textContent = `${h}h ${m.toString().padStart(2, '0')}m`;
      labelEl.textContent = 'fasting';
    } else {
      timeEl.textContent = 'Done!';
      labelEl.textContent = 'fast complete';
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
    $('#rings-badge').textContent = `${state.rings || 0} rings`;
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
    // Hide manual buttons — fasting is automatic now
    const startBtn = $('#fasting-start-btn');
    const endBtn = $('#fasting-end-btn');
    if (startBtn) startBtn.classList.add('hidden');
    if (endBtn) endBtn.classList.add('hidden');

    const startH = state.fastStartHour > 12 ? state.fastStartHour - 12 : state.fastStartHour;
    const startAP = state.fastStartHour >= 12 ? 'PM' : 'AM';
    const endH = state.fastEndHour > 12 ? state.fastEndHour - 12 : state.fastEndHour;
    const endAP = state.fastEndHour >= 12 ? 'PM' : 'AM';
    $('#fasting-streak-display').textContent = `${startH}${startAP} \u2192 ${endH}${endAP} daily`;
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
            <button class="history-edit" onclick="window.__editEntry(${realIndex})" title="Edit">&#9998;</button>
            <button class="history-delete" onclick="window.__deleteEntry(${realIndex})" title="Delete">&times;</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Expose edit/delete to onclick
  window.__editEntry = (i) => {
    const entry = state.entries[i];
    if (!entry) return;
    const newVal = prompt(`Edit weight (${state.unit}):`, entry.weight.toFixed(1));
    if (newVal === null) return;
    const parsed = parseFloat(newVal);
    if (!parsed || parsed < 50 || parsed > 999) {
      showToast('Invalid weight', 'error');
      return;
    }
    state.entries[i].weight = parsed;

    const newDate = prompt('Edit date (YYYY-MM-DD):', entry.date);
    if (newDate !== null) {
      const trimmed = newDate.trim();
      if (trimmed.match(/^\d{4}-\d{2}-\d{2}$/)) {
        state.entries[i].date = trimmed;
        state.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
      } else if (trimmed !== '') {
        showToast('Invalid date format', 'error');
      }
    }

    save();
    renderDashboard();
    showToast('Entry updated', 'success');
  };

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

    let entries = [...state.entries].sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
    if (range !== 'all') {
      const days = parseInt(range);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = dateStr(cutoff);
      entries = entries.filter(e => e.date >= cutoffStr);
    }

    if (entries.length < 2) {
      ctx.fillStyle = '#8b7e5a';
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Need 2+ entries', rect.width / 2, rect.height / 2);
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

    // Grid lines (dashed pixel style)
    ctx.fillStyle = '#a09070';
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const y = Math.round(padY + (chartH / gridLines) * i);
      // Dashed pixel line
      for (let gx = padX; gx < w - 16; gx += 8) {
        ctx.fillRect(gx, y, 4, 1);
      }
      const val = maxW - (maxW - minW) * (i / gridLines);
      ctx.fillStyle = '#8b7e5a';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(0), padX - 6, y + 3);
      ctx.fillStyle = '#a09070';
    }

    // Goal line (pixel dashed)
    if (state.goalWeight >= minW && state.goalWeight <= maxW) {
      const goalY = Math.round(padY + chartH * (1 - (state.goalWeight - minW) / (maxW - minW)));
      ctx.fillStyle = '#8b7e5a';
      for (let gx = padX; gx < w - 16; gx += 10) {
        ctx.fillRect(gx, goalY, 6, 2);
      }
      ctx.font = '7px "Press Start 2P", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('GOAL', w - 50, goalY - 4);
    }

    // Area fill (pixel scanline pattern)
    ctx.fillStyle = 'rgba(42, 32, 16, 0.06)';
    entries.forEach((entry, i) => {
      if (i >= entries.length - 1) return;
      const x1 = Math.round(padX + (i / (entries.length - 1)) * chartW);
      const y1 = Math.round(padY + chartH * (1 - (entry.weight - minW) / (maxW - minW)));
      const x2 = Math.round(padX + ((i + 1) / (entries.length - 1)) * chartW);
      const y2 = Math.round(padY + chartH * (1 - (entries[i + 1].weight - minW) / (maxW - minW)));
      // Fill column strips
      for (let fx = x1; fx < x2; fx += 2) {
        const t = (fx - x1) / (x2 - x1);
        const fy = y1 + (y2 - y1) * t;
        ctx.fillRect(fx, Math.round(fy), 2, Math.round(padY + chartH - fy));
      }
    });

    // Weight line (stepped pixel line)
    ctx.fillStyle = '#2a2010';
    entries.forEach((entry, i) => {
      if (i >= entries.length - 1) return;
      const x1 = Math.round(padX + (i / (entries.length - 1)) * chartW);
      const y1 = Math.round(padY + chartH * (1 - (entry.weight - minW) / (maxW - minW)));
      const x2 = Math.round(padX + ((i + 1) / (entries.length - 1)) * chartW);
      const y2 = Math.round(padY + chartH * (1 - (entries[i + 1].weight - minW) / (maxW - minW)));

      // Bresenham-style pixel line
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const sx = x1 < x2 ? 2 : -2;
      const sy = y1 < y2 ? 2 : -2;
      let err = dx - dy;
      let cx = x1, cyy = y1;
      while (true) {
        ctx.fillRect(cx, cyy, 3, 3);
        if (Math.abs(cx - x2) < 3 && Math.abs(cyy - y2) < 3) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cyy += sy; }
      }
    });

    // Points (pixel squares)
    entries.forEach((entry, i) => {
      const x = Math.round(padX + (i / (entries.length - 1)) * chartW);
      const y = Math.round(padY + chartH * (1 - (entry.weight - minW) / (maxW - minW)));
      // Outer square
      ctx.fillStyle = '#2a2010';
      ctx.fillRect(x - 4, y - 4, 9, 9);
      // Inner square
      ctx.fillStyle = '#2a2010';
      ctx.fillRect(x - 3, y - 3, 7, 7);
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

  // ===== Chao Shop =====
  function openShop() {
    $('#shop-modal').classList.remove('hidden');
    $('#shop-rings').textContent = `${state.rings || 0} rings`;
    $$('.shop-cat-btn').forEach(b => b.classList.remove('active'));
    $$('.shop-cat-btn')[0].classList.add('active');
    renderShopGrid('all');
  }

  function renderShopGrid(category) {
    const grid = $('#shop-grid');
    const chao = getActiveChao();
    const equipped = chao && chao.accessories ? chao.accessories : [];
    const inv = state.inventory || [];

    const items = category === 'all' ? ACCESSORIES : ACCESSORIES.filter(a => a.category === category);

    grid.innerHTML = items.map(item => {
      const owned = inv.includes(item.id);
      const isEquipped = equipped.includes(item.id);
      const canAfford = (state.rings || 0) >= item.price;
      let btnText, btnClass, btnDisabled;
      if (isEquipped) {
        btnText = 'Unequip';
        btnClass = 'unequip-btn';
        btnDisabled = false;
      } else if (owned) {
        btnText = 'Equip';
        btnClass = 'equip-btn';
        btnDisabled = false;
      } else {
        btnText = `${item.price} rings`;
        btnClass = '';
        btnDisabled = !canAfford;
      }
      return `<div class="shop-item${owned ? ' owned' : ''}${isEquipped ? ' equipped' : ''}">
        <div class="shop-item-name">${item.name}</div>
        <div class="shop-item-desc">${item.desc}</div>
        ${!owned ? `<div class="shop-item-price">${item.price} rings</div>` : ''}
        <button class="shop-item-btn ${btnClass}" data-id="${item.id}" ${btnDisabled ? 'disabled' : ''}>${btnText}</button>
      </div>`;
    }).join('');

    grid.querySelectorAll('.shop-item-btn').forEach(btn => {
      btn.addEventListener('click', () => handleShopAction(btn.dataset.id));
    });
  }

  function handleShopAction(itemId) {
    const item = ACCESSORIES.find(a => a.id === itemId);
    if (!item) return;
    const inv = state.inventory || [];
    const chao = getActiveChao();
    if (!chao) return;
    if (!chao.accessories) chao.accessories = [];

    if (chao.accessories.includes(itemId)) {
      // Unequip
      chao.accessories = chao.accessories.filter(id => id !== itemId);
      save();
      showToast(`Unequipped ${item.name}`, 'success');
    } else if (inv.includes(itemId)) {
      // Equip — only one per category
      const sameCategory = ACCESSORIES.filter(a => a.category === item.category).map(a => a.id);
      chao.accessories = chao.accessories.filter(id => !sameCategory.includes(id));
      chao.accessories.push(itemId);
      save();
      showToast(`Equipped ${item.name}!`, 'success');
    } else {
      // Buy
      if ((state.rings || 0) < item.price) {
        showToast('Not enough rings!', 'error');
        return;
      }
      state.rings -= item.price;
      if (!state.inventory) state.inventory = [];
      state.inventory.push(itemId);
      // Auto-equip if no item in that category
      const sameCategory = ACCESSORIES.filter(a => a.category === item.category).map(a => a.id);
      if (!chao.accessories.some(id => sameCategory.includes(id))) {
        chao.accessories.push(itemId);
      }
      save();
      showToast(`Bought ${item.name}!`, 'success');
    }

    $('#shop-rings').textContent = `${state.rings || 0} rings`;
    const activeCat = document.querySelector('.shop-cat-btn.active');
    renderShopGrid(activeCat ? activeCat.dataset.cat : 'all');
    renderEquippedList();
    renderPet();
  }

  function renderEquippedList() {
    const chao = getActiveChao();
    const el = $('#equipped-list');
    if (!chao || !chao.accessories || chao.accessories.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = chao.accessories.map(id => {
      const item = ACCESSORIES.find(a => a.id === id);
      return item ? `<span class="equipped-tag" data-id="${id}" title="Click to unequip">${item.name}</span>` : '';
    }).join('');
    el.querySelectorAll('.equipped-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const curchao = getActiveChao();
        if (curchao && curchao.accessories) {
          curchao.accessories = curchao.accessories.filter(id => id !== tag.dataset.id);
          save();
          renderEquippedList();
          renderPet();
        }
      });
    });
  }

  // ===== Nav =====
  function scrollToSection(el) {
    if (!el) return;
    const navHeight = 60;
    const y = el.getBoundingClientRect().top + window.pageYOffset - navHeight;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function handleNavTab(tab) {
    if (tab === 'log') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => $('#weight-input').focus(), 400);
    } else if (tab === 'home') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tab === 'pet') {
      scrollToSection($('.pet-section'));
    } else if (tab === 'stats') {
      scrollToSection($('.chart-section'));
    } else if (tab === 'trophies') {
      scrollToSection($('.achievements-section'));
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
        // Also clear cloud data
        if (db && currentUser) {
          db.collection('users').doc(currentUser.uid).delete().catch(() => {});
        }
        state = { ...defaults };
        if (auth) {
          showScreen('auth-screen');
        } else {
          showScreen('onboarding');
        }
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

  // ===== Samsung Health Import =====
  function importSamsungHealth(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        showToast('Empty or invalid file', 'error');
        return;
      }

      // Parse header to find relevant columns
      const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      // Samsung Health uses fully qualified column names like:
      // com.samsung.health.weight.weight
      // com.samsung.health.weight.create_time
      // Or sometimes just: weight, create_time
      const weightIdx = header.findIndex(h =>
        h === 'com.samsung.health.weight.weight' ||
        h === 'weight' ||
        h.toLowerCase().endsWith('.weight')
      );
      const timeIdx = header.findIndex(h =>
        h === 'com.samsung.health.weight.create_time' ||
        h === 'create_time' ||
        h.toLowerCase().includes('create_time')
      );
      // Also check for update_time or start_time as fallbacks
      const altTimeIdx = timeIdx >= 0 ? timeIdx : header.findIndex(h =>
        h.toLowerCase().includes('update_time') ||
        h.toLowerCase().includes('start_time')
      );
      const timeColIdx = timeIdx >= 0 ? timeIdx : altTimeIdx;

      if (weightIdx < 0) {
        showToast('No weight column found in file', 'error');
        return;
      }
      if (timeColIdx < 0) {
        showToast('No date/time column found', 'error');
        return;
      }

      // Check for time offset column
      const offsetIdx = header.findIndex(h =>
        h === 'com.samsung.health.weight.time_offset' ||
        h === 'time_offset' ||
        h.toLowerCase().includes('time_offset')
      );

      let imported = 0;
      let skipped = 0;

      for (let i = 1; i < lines.length; i++) {
        // Handle CSV with possible quoted fields
        const cols = parseCSVLine(lines[i]);
        if (!cols || cols.length <= Math.max(weightIdx, timeColIdx)) continue;

        const rawWeight = parseFloat(cols[weightIdx]);
        const rawTime = cols[timeColIdx].trim().replace(/"/g, '');
        if (isNaN(rawWeight) || rawWeight <= 0) { skipped++; continue; }

        // Parse timestamp — Samsung uses Unix epoch in milliseconds
        let date;
        const msTimestamp = parseInt(rawTime);
        if (!isNaN(msTimestamp) && msTimestamp > 1000000000000) {
          // Unix ms timestamp
          let offsetMs = 0;
          if (offsetIdx >= 0 && cols[offsetIdx]) {
            offsetMs = parseInt(cols[offsetIdx]) || 0;
          }
          date = new Date(msTimestamp + offsetMs);
        } else if (rawTime.match(/\d{4}-\d{2}-\d{2}/)) {
          // ISO date string
          date = new Date(rawTime);
        } else {
          skipped++;
          continue;
        }

        if (isNaN(date.getTime())) { skipped++; continue; }

        const dateKey = date.getFullYear() + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' +
          String(date.getDate()).padStart(2, '0');

        // Samsung Health always stores weight in kg
        let weight = rawWeight;
        if (state.unit === 'lbs') {
          weight = rawWeight * 2.20462;
        }
        weight = Math.round(weight * 10) / 10;

        // Only add if no entry exists for this date, or update with latest
        const existing = state.entries.findIndex(e => e.date === dateKey);
        if (existing >= 0) {
          // Keep the later timestamp
          if (date.getTime() > (state.entries[existing].ts || 0)) {
            state.entries[existing].weight = weight;
            state.entries[existing].ts = date.getTime();
          }
        } else {
          state.entries.push({ date: dateKey, weight, ts: date.getTime() });
        }
        imported++;
      }

      state.entries.sort((a, b) => a.date.localeCompare(b.date));
      save();
      renderDashboard();

      if (imported > 0) {
        showToast(`Imported ${imported} entries from Samsung Health!`, 'success');
      } else {
        showToast(`No valid entries found (${skipped} skipped)`, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // Simple CSV line parser that handles quoted fields
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
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
    neutral:  { body: '#5c6a8a', highlight: '#8dd8f8', belly: '#d4f1ff', bobble: '#ffd600', name: 'Neutral' },
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

  // ===== Drawing Chao (Pixel Art) =====
  function pxRect(ctx, x, y, w, h, s) {
    // Snap to pixel grid for crispy rendering
    const px = Math.round(s * 2); // pixel unit size
    ctx.fillRect(
      Math.round(x / px) * px,
      Math.round(y / px) * px,
      Math.round(w / px) * px || px,
      Math.round(h / px) * px || px
    );
  }

  function drawChao(ctx, chao, x, y, scale, frame) {
    const colors = CHAO_TYPES[chao.type] || CHAO_TYPES.neutral;
    const mood = getChaoMood(chao);
    const stage = chao.stage;
    const s = scale;
    const p = Math.round(s * 2); // pixel unit

    const bounce = Math.round(Math.sin(frame * 0.06 + x) * 2) * s;
    const cy = y + bounce;

    // Shadow (pixelated rectangle)
    ctx.fillStyle = 'rgba(42, 32, 16, 0.2)';
    ctx.fillRect(x - 12 * s, y + 34 * s, 24 * s, 4 * s);

    if (stage === 0) {
      // EGG — stacked pixel rectangles
      ctx.fillStyle = '#8b7e5a';
      ctx.fillRect(x - 6 * s, cy - 14 * s, 12 * s, 2 * s);
      ctx.fillRect(x - 10 * s, cy - 12 * s, 20 * s, 2 * s);
      ctx.fillRect(x - 12 * s, cy - 10 * s, 24 * s, 18 * s);
      ctx.fillRect(x - 10 * s, cy + 8 * s, 20 * s, 2 * s);
      ctx.fillRect(x - 6 * s, cy + 10 * s, 12 * s, 2 * s);

      // Speckles
      ctx.fillStyle = colors.body;
      ctx.fillRect(x - 6 * s, cy - 6 * s, 4 * s, 4 * s);
      ctx.fillRect(x + 4 * s, cy - 2 * s, 4 * s, 4 * s);
      ctx.fillRect(x - 2 * s, cy + 4 * s, 4 * s, 4 * s);
      ctx.fillRect(x + 6 * s, cy - 8 * s, 3 * s, 3 * s);

      // Crack
      if (chao.xp >= 12) {
        ctx.fillStyle = '#8b7e5a';
        ctx.fillRect(x - 4 * s, cy - 4 * s, 2 * s, 2 * s);
        ctx.fillRect(x - 2 * s, cy - 2 * s, 2 * s, 2 * s);
        ctx.fillRect(x, cy - 4 * s, 2 * s, 2 * s);
        ctx.fillRect(x + 2 * s, cy - 6 * s, 2 * s, 2 * s);
      }
      return;
    }

    // BODY - stacked rectangles to form round chao shape
    const bw = (stage >= 3) ? 14 : (stage >= 2) ? 12 : 10;
    const bh = (stage >= 3) ? 20 : (stage >= 2) ? 18 : 14;

    // Cape draws behind body
    if (chao.accessories && chao.accessories.includes('cape')) {
      ctx.fillStyle = '#8e44ad';
      const capeTop = cy - 2 * s;
      ctx.fillRect(x - bw * s - 3 * s, capeTop, bw * 2 * s + 6 * s, 2 * s);
      ctx.fillRect(x - bw * s - 4 * s, capeTop + 2 * s, bw * 2 * s + 8 * s, bh * 0.6 * s);
      const capeFlutter = Math.round(Math.sin(frame * 0.08) * 2) * s;
      ctx.fillRect(x - bw * s - 5 * s, capeTop + 2 * s + bh * 0.6 * s, bw * 2 * s + 10 * s + capeFlutter, 3 * s);
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(x - bw * s - 2 * s, capeTop + 3 * s, bw * 2 * s + 4 * s, bh * 0.3 * s);
    }

    // Body shape (pixel oval via stacked rects)
    ctx.fillStyle = colors.body;
    ctx.fillRect(x - bw * 0.4 * s, cy - bh * 0.5 * s, bw * 0.8 * s, 2 * s);         // top
    ctx.fillRect(x - bw * 0.7 * s, cy - bh * 0.5 * s + 2 * s, bw * 1.4 * s, 2 * s);
    ctx.fillRect(x - bw * s, cy - bh * 0.5 * s + 4 * s, bw * 2 * s, bh * s - 4 * s); // main
    ctx.fillRect(x - bw * 0.7 * s, cy + bh * 0.5 * s, bw * 1.4 * s, 2 * s);
    ctx.fillRect(x - bw * 0.4 * s, cy + bh * 0.5 * s + 2 * s, bw * 0.8 * s, 2 * s);  // bottom

    // Belly highlight
    ctx.fillStyle = colors.belly;
    ctx.fillRect(x - bw * 0.45 * s, cy + 2 * s, bw * 0.9 * s, bh * 0.4 * s);

    // FLOATING BOBBLE above head (the signature Chao detail!)
    const bobbleY = cy - bh * 0.5 * s - 10 * s + Math.round(Math.sin(frame * 0.1 + x * 0.1) * 2) * s;
    const bobSize = (stage >= 3 ? 5 : stage >= 2 ? 4 : 3.5) * s;
    ctx.fillStyle = colors.bobble;
    // Pixel circle for bobble
    ctx.fillRect(x - bobSize * 0.7, bobbleY - bobSize, bobSize * 1.4, bobSize * 2);
    ctx.fillRect(x - bobSize, bobbleY - bobSize * 0.7, bobSize * 2, bobSize * 1.4);
    // Bobble shine
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x - bobSize * 0.4, bobbleY - bobSize * 0.5, bobSize * 0.5, bobSize * 0.5);

    // Bobble stem (thin line connecting to head)
    ctx.fillStyle = colors.bobble;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(x - s * 0.5, bobbleY + bobSize, s, (cy - bh * 0.5 * s) - (bobbleY + bobSize));
    ctx.globalAlpha = 1;

    // WINGS
    if (stage >= 1) {
      ctx.fillStyle = colors.highlight;
      const ws = (stage >= 3) ? 8 : (stage >= 2) ? 6 : 4;
      const wingFlap = Math.round(Math.sin(frame * 0.15 + x) * 2) * s;

      // Left wing (pixel triangleish)
      const lx = x - bw * s - 2 * s;
      const wy = cy - 4 * s + wingFlap;
      ctx.fillRect(lx, wy, ws * 0.6 * s, 2 * s);
      ctx.fillRect(lx - 2 * s, wy + 2 * s, ws * 0.6 * s + 2 * s, 2 * s);
      ctx.fillRect(lx, wy + 4 * s, ws * 0.6 * s, 2 * s);

      // Right wing
      const rx = x + bw * s + 2 * s - ws * 0.6 * s;
      ctx.fillRect(rx, wy, ws * 0.6 * s, 2 * s);
      ctx.fillRect(rx, wy + 2 * s, ws * 0.6 * s + 2 * s, 2 * s);
      ctx.fillRect(rx, wy + 4 * s, ws * 0.6 * s, 2 * s);
    }

    // EYES (pixel dots)
    const eyeY = cy - 4 * s;
    const eyeSpacing = 4 * s;
    const eyeSize = 2 * s;
    const blinking = frame % 120 > 115;

    if (blinking && mood !== 'sad') {
      // Blink — horizontal line
      ctx.fillStyle = '#2a2010';
      ctx.fillRect(x - eyeSpacing - eyeSize, eyeY, eyeSize * 2, s);
      ctx.fillRect(x + eyeSpacing - eyeSize, eyeY, eyeSize * 2, s);
    } else {
      ctx.fillStyle = '#2a2010';
      if (mood === 'sad') {
        // Sad — flat top eyes
        ctx.fillRect(x - eyeSpacing - eyeSize, eyeY, eyeSize * 2, eyeSize);
        ctx.fillRect(x + eyeSpacing - eyeSize, eyeY, eyeSize * 2, eyeSize);
        // Flat brow on top
        ctx.fillRect(x - eyeSpacing - eyeSize - s, eyeY - s, eyeSize * 2 + s, s);
        ctx.fillRect(x + eyeSpacing - eyeSize, eyeY - s, eyeSize * 2 + s, s);
      } else {
        // Normal / happy — square pixel eyes
        ctx.fillRect(x - eyeSpacing - eyeSize, eyeY - eyeSize, eyeSize * 2, eyeSize * 2);
        ctx.fillRect(x + eyeSpacing - eyeSize, eyeY - eyeSize, eyeSize * 2, eyeSize * 2);
        if (mood === 'happy') {
          // Eye sparkle pixel
          ctx.fillStyle = '#fff';
          ctx.fillRect(x - eyeSpacing, eyeY - eyeSize, s, s);
          ctx.fillRect(x + eyeSpacing, eyeY - eyeSize, s, s);
        }
      }
    }

    // MOUTH (pixel)
    if (mood === 'happy') {
      ctx.fillStyle = '#8a4a2a';
      ctx.fillRect(x - 2 * s, eyeY + 4 * s, 4 * s, s);
      ctx.fillRect(x - 3 * s, eyeY + 3 * s, s, s);
      ctx.fillRect(x + 2 * s, eyeY + 3 * s, s, s);
    } else if (mood === 'sad') {
      ctx.fillStyle = '#8a4a2a';
      ctx.fillRect(x - 2 * s, eyeY + 5 * s, 4 * s, s);
      ctx.fillRect(x - 3 * s, eyeY + 6 * s, s, s);
      ctx.fillRect(x + 2 * s, eyeY + 6 * s, s, s);
    } else {
      ctx.fillStyle = '#8a4a2a';
      ctx.fillRect(x - 2 * s, eyeY + 4 * s, 4 * s, s);
    }

    // FEET (pixel nubs)
    ctx.fillStyle = colors.body;
    ctx.fillRect(x - 6 * s, cy + bh * 0.5 * s + 2 * s, 4 * s, 3 * s);
    ctx.fillRect(x + 2 * s, cy + bh * 0.5 * s + 2 * s, 4 * s, 3 * s);

    // HANDS (stage 2+)
    if (stage >= 2) {
      ctx.fillStyle = colors.highlight;
      ctx.fillRect(x - bw * s - 1 * s, cy + 6 * s, 3 * s, 3 * s);
      ctx.fillRect(x + bw * s - 2 * s, cy + 6 * s, 3 * s, 3 * s);
    }

    // ACCESSORIES
    if (chao.accessories && chao.accessories.length > 0) {
      drawChaoAccessories(ctx, chao, x, cy, s, bw, bh, frame);
    }

    // Chaos aura (stage 4) - flickering pixel border
    if (stage >= 4) {
      ctx.fillStyle = colors.bobble;
      ctx.globalAlpha = 0.15 + Math.sin(frame * 0.08) * 0.1;
      // Top aura
      ctx.fillRect(x - bw * s - 4 * s, cy - bh * 0.5 * s - 4 * s, bw * 2 * s + 8 * s, 2 * s);
      // Bottom aura
      ctx.fillRect(x - bw * s - 4 * s, cy + bh * 0.5 * s + 4 * s, bw * 2 * s + 8 * s, 2 * s);
      // Side auras
      ctx.fillRect(x - bw * s - 4 * s, cy - bh * 0.5 * s, 2 * s, bh * s + 8 * s);
      ctx.fillRect(x + bw * s + 2 * s, cy - bh * 0.5 * s, 2 * s, bh * s + 8 * s);
      ctx.globalAlpha = 1;
    }

    // Mood particles (pixel sparkles)
    if (mood === 'happy' && frame % 40 < 8) {
      ctx.fillStyle = colors.bobble;
      const px1 = x - 16 * s + Math.round(Math.sin(frame * 0.2) * 8) * s;
      const py1 = cy - 18 * s - (frame % 40) * s;
      ctx.fillRect(px1, py1, 2 * s, 2 * s);
      ctx.fillRect(px1 + 20 * s, py1 + 4 * s, 2 * s, 2 * s);
    }

    // Tears (pixel)
    if (mood === 'sad' && frame % 60 < 30) {
      ctx.fillStyle = '#5c6a8a';
      const tearOff = (frame % 60) * 0.8 * s;
      ctx.fillRect(x - eyeSpacing, eyeY + eyeSize + tearOff, 2 * s, 3 * s);
    }

    // Sleeping Z's
    if (chao.energy < 30) {
      ctx.fillStyle = '#8b7e5a';
      ctx.font = `${Math.round(8 * s)}px "Press Start 2P", monospace`;
      ctx.fillText('z', x + 14 * s + Math.round(Math.sin(frame * 0.03) * 2) * s, cy - 18 * s + bounce);
      ctx.font = `${Math.round(6 * s)}px "Press Start 2P", monospace`;
      ctx.fillText('z', x + 20 * s, cy - 26 * s + bounce);
    }
  }

  function drawChaoAccessories(ctx, chao, x, cy, s, bw, bh, frame) {
    const topY = cy - bh * 0.5 * s; // top of body
    const eyeY = cy - 4 * s;

    chao.accessories.forEach(id => {
      switch (id) {
        case 'bow': {
          // Cute bow on top of head
          ctx.fillStyle = '#e74c3c';
          ctx.fillRect(x - 6 * s, topY - 4 * s, 4 * s, 3 * s); // left loop
          ctx.fillRect(x + 2 * s, topY - 4 * s, 4 * s, 3 * s); // right loop
          ctx.fillStyle = '#c0392b';
          ctx.fillRect(x - 1 * s, topY - 3 * s, 2 * s, 2 * s); // center knot
          break;
        }
        case 'party_hat': {
          ctx.fillStyle = '#9b59b6';
          ctx.fillRect(x - 6 * s, topY - 2 * s, 12 * s, 3 * s); // base
          ctx.fillRect(x - 4 * s, topY - 5 * s, 8 * s, 3 * s);  // mid
          ctx.fillRect(x - 2 * s, topY - 8 * s, 4 * s, 3 * s);  // top
          // Pom pom
          ctx.fillStyle = '#ffd600';
          ctx.fillRect(x - 2 * s, topY - 10 * s, 4 * s, 2 * s);
          // Stripe
          ctx.fillStyle = '#f39c12';
          ctx.fillRect(x - 5 * s, topY - 3 * s, 10 * s, 1 * s);
          break;
        }
        case 'crown': {
          ctx.fillStyle = '#ffd600';
          ctx.fillRect(x - 7 * s, topY - 2 * s, 14 * s, 3 * s); // base
          // Points
          ctx.fillRect(x - 7 * s, topY - 5 * s, 3 * s, 3 * s);
          ctx.fillRect(x - 1 * s, topY - 6 * s, 2 * s, 4 * s);
          ctx.fillRect(x + 4 * s, topY - 5 * s, 3 * s, 3 * s);
          // Jewel
          ctx.fillStyle = '#e74c3c';
          ctx.fillRect(x - 1 * s, topY - 1 * s, 2 * s, 2 * s);
          break;
        }
        case 'top_hat': {
          ctx.fillStyle = '#2a2010';
          ctx.fillRect(x - 8 * s, topY - 2 * s, 16 * s, 2 * s); // brim
          ctx.fillRect(x - 5 * s, topY - 10 * s, 10 * s, 8 * s); // cylinder
          // Band
          ctx.fillStyle = '#8b7e5a';
          ctx.fillRect(x - 5 * s, topY - 4 * s, 10 * s, 2 * s);
          break;
        }
        case 'halo': {
          const haloAlpha = 0.6 + Math.sin(frame * 0.1) * 0.2;
          ctx.fillStyle = `rgba(255, 214, 0, ${haloAlpha})`;
          ctx.fillRect(x - 8 * s, topY - 8 * s, 16 * s, 2 * s); // top
          ctx.fillRect(x - 10 * s, topY - 6 * s, 4 * s, 2 * s); // left
          ctx.fillRect(x + 6 * s, topY - 6 * s, 4 * s, 2 * s);  // right
          ctx.fillRect(x - 8 * s, topY - 4 * s, 16 * s, 2 * s); // bottom (ring)
          // Make it a ring shape with hollow center (just skip middle pixels)
          break;
        }
        case 'devil_horns': {
          ctx.fillStyle = '#c0392b';
          // Left horn
          ctx.fillRect(x - 8 * s, topY - 2 * s, 3 * s, 2 * s);
          ctx.fillRect(x - 9 * s, topY - 5 * s, 3 * s, 3 * s);
          ctx.fillRect(x - 8 * s, topY - 7 * s, 2 * s, 2 * s);
          // Right horn
          ctx.fillRect(x + 5 * s, topY - 2 * s, 3 * s, 2 * s);
          ctx.fillRect(x + 6 * s, topY - 5 * s, 3 * s, 3 * s);
          ctx.fillRect(x + 6 * s, topY - 7 * s, 2 * s, 2 * s);
          break;
        }
        case 'flower': {
          // Petals
          ctx.fillStyle = '#ff69b4';
          ctx.fillRect(x - 1 * s, topY - 7 * s, 2 * s, 2 * s); // top
          ctx.fillRect(x - 4 * s, topY - 5 * s, 2 * s, 2 * s); // left
          ctx.fillRect(x + 2 * s, topY - 5 * s, 2 * s, 2 * s); // right
          ctx.fillRect(x - 1 * s, topY - 3 * s, 2 * s, 2 * s); // bottom
          // Center
          ctx.fillStyle = '#ffd600';
          ctx.fillRect(x - 1 * s, topY - 5 * s, 2 * s, 2 * s);
          break;
        }
        case 'sunglasses': {
          ctx.fillStyle = '#2a2010';
          // Left lens
          ctx.fillRect(x - 8 * s, eyeY - 2 * s, 6 * s, 4 * s);
          // Right lens
          ctx.fillRect(x + 2 * s, eyeY - 2 * s, 6 * s, 4 * s);
          // Bridge
          ctx.fillRect(x - 2 * s, eyeY - 1 * s, 4 * s, 1 * s);
          // Tinted glass
          ctx.fillStyle = 'rgba(42, 32, 16, 0.5)';
          ctx.fillRect(x - 7 * s, eyeY - 1 * s, 4 * s, 2 * s);
          ctx.fillRect(x + 3 * s, eyeY - 1 * s, 4 * s, 2 * s);
          break;
        }
        case 'round_glasses': {
          ctx.fillStyle = '#5c4a28';
          // Left frame
          ctx.fillRect(x - 8 * s, eyeY - 3 * s, 6 * s, 1 * s); // top
          ctx.fillRect(x - 8 * s, eyeY + 2 * s, 6 * s, 1 * s); // bottom
          ctx.fillRect(x - 8 * s, eyeY - 3 * s, 1 * s, 6 * s); // left
          ctx.fillRect(x - 3 * s, eyeY - 3 * s, 1 * s, 6 * s); // right
          // Right frame
          ctx.fillRect(x + 2 * s, eyeY - 3 * s, 6 * s, 1 * s);
          ctx.fillRect(x + 2 * s, eyeY + 2 * s, 6 * s, 1 * s);
          ctx.fillRect(x + 2 * s, eyeY - 3 * s, 1 * s, 6 * s);
          ctx.fillRect(x + 7 * s, eyeY - 3 * s, 1 * s, 6 * s);
          // Bridge
          ctx.fillRect(x - 2 * s, eyeY - 1 * s, 4 * s, 1 * s);
          break;
        }
        case 'bowtie': {
          const neckY = cy + bh * 0.3 * s;
          ctx.fillStyle = '#e74c3c';
          // Left triangle
          ctx.fillRect(x - 6 * s, neckY, 4 * s, 1 * s);
          ctx.fillRect(x - 5 * s, neckY + 1 * s, 3 * s, 1 * s);
          ctx.fillRect(x - 4 * s, neckY + 2 * s, 2 * s, 1 * s);
          // Right triangle
          ctx.fillRect(x + 2 * s, neckY, 4 * s, 1 * s);
          ctx.fillRect(x + 2 * s, neckY + 1 * s, 3 * s, 1 * s);
          ctx.fillRect(x + 2 * s, neckY + 2 * s, 2 * s, 1 * s);
          // Center knot
          ctx.fillStyle = '#c0392b';
          ctx.fillRect(x - 1 * s, neckY, 2 * s, 3 * s);
          break;
        }
        case 'scarf': {
          const neckY = cy + bh * 0.25 * s;
          ctx.fillStyle = '#3498db';
          // Wrap around neck
          ctx.fillRect(x - bw * s, neckY, bw * 2 * s, 3 * s);
          // Hanging end
          ctx.fillRect(x + 4 * s, neckY + 3 * s, 4 * s, 6 * s);
          ctx.fillRect(x + 3 * s, neckY + 9 * s, 4 * s, 2 * s);
          // Stripe
          ctx.fillStyle = '#2980b9';
          ctx.fillRect(x - bw * s, neckY + 1 * s, bw * 2 * s, 1 * s);
          break;
        }
        case 'cape':
          // Drawn behind body in drawChao
          break;
      }
    });
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
      ctx.fillStyle = '#8a4a2a';
      drawHeart(ctx, p.x, p.y, p.size);
      ctx.globalAlpha = 1;
    });
  }

  function drawHeart(ctx, x, y, size) {
    // Pixel heart - 5x5 grid
    const p = size / 5;
    // Row 0:  .X.X.
    ctx.fillRect(x - 2*p, y, p, p);
    ctx.fillRect(x + p, y, p, p);
    // Row 1: XXXXX
    ctx.fillRect(x - 2.5*p, y + p, 5*p, p);
    // Row 2: .XXX.
    ctx.fillRect(x - 1.5*p, y + 2*p, 3*p, p);
    // Row 3: ..X..
    ctx.fillRect(x - 0.5*p, y + 3*p, p, p);
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

    // Garden background - pixel ground
    ctx.fillStyle = 'rgba(42, 32, 16, 0.08)';
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
    // Pixel ground line
    ctx.fillStyle = 'rgba(42, 32, 16, 0.12)';
    const groundY = Math.round(h * 0.78);
    for (let gx = 0; gx < w; gx += 8) {
      const gy = groundY + ((gx / 8) % 3 === 0 ? -2 : 0);
      ctx.fillRect(gx, gy, 8, 2);
    }
    // Small pixel grass tufts
    ctx.fillStyle = 'rgba(42, 32, 16, 0.1)';
    for (let gx = 20; gx < w - 20; gx += 40) {
      ctx.fillRect(gx, groundY - 4, 2, 4);
      ctx.fillRect(gx + 4, groundY - 6, 2, 6);
      ctx.fillRect(gx + 8, groundY - 3, 2, 3);
    }

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
    renderEquippedList();
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
