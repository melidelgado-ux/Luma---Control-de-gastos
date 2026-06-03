import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const LEGACY_STORAGE_KEYS = ["luma-finance-prototype"];
const FIREBASE_REQUIRED_KEYS = ["apiKey", "authDomain", "projectId", "appId"];

const today = new Date("2026-06-02T12:00:00");
const monthKey = "2026-06";
const monthLabel = "Junio 2026";
const FRELO_RATE_USD = 10;
const INCOME_TYPES = [
  "first_half",
  "first_discount",
  "second_half",
  "second_discount",
  "health",
  "freelo",
  "extra"
];
const FIXED_INCOME_TYPES = INCOME_TYPES.filter((type) => type !== "extra");
const INCOME_LABELS = {
  first_half: "Primera quincena",
  first_discount: "Descuento primera quincena",
  second_half: "Segunda quincena",
  second_discount: "Descuento segunda quincena",
  health: "Seguro salud",
  freelo: "Freelo",
  extra: "Ingreso extra"
};
const CATEGORY_ICON_OPTIONS = [
  { icon: "fa-credit-card", label: "Tarjeta" },
  { icon: "fa-hand-holding-dollar", label: "Prestamo" },
  { icon: "fa-house-chimney", label: "Casa" },
  { icon: "fa-heart-pulse", label: "Salud" },
  { icon: "fa-wallet", label: "Otros" },
  { icon: "fa-repeat", label: "Suscripcion" },
  { icon: "fa-gift", label: "Regalo" },
  { icon: "fa-paw", label: "Mascotas" },
  { icon: "fa-spa", label: "Bienestar" },
  { icon: "fa-car", label: "Auto" },
  { icon: "fa-laptop", label: "Tecnologia" },
  { icon: "fa-burger", label: "Comida" }
];
const DEFAULT_CATEGORY_ICONS = {
  Tarjetas: "fa-credit-card",
  Prestamos: "fa-hand-holding-dollar",
  Casa: "fa-house-chimney",
  "Seguros y salud": "fa-heart-pulse",
  Otros: "fa-wallet",
  Suscripciones: "fa-repeat",
  Regalos: "fa-gift",
  Bienestar: "fa-spa",
  Mascotas: "fa-paw",
  Tecnologia: "fa-laptop",
  Comida: "fa-burger"
};
const CHART_TONES = ["blue", "purple", "green", "amber", "pink", "cyan", "lime", "coral"];

const initialState = {
  user: null,
  incomeUsd: 0,
  incomes: [],
  expenses: [],
  rates: [],
  freelo: [],
  projects: [],
  categories: [],
  expenseFilter: "all",
  statsMode: "usd"
};

let state = normalizeState(clone(initialState));
let selectedFreeloId = null;
let selectedExpenseId = null;
let selectedIncomeId = null;
let isEditingExpense = false;
let isEditingIncome = false;
let selectedNewCategoryIcon = CATEGORY_ICON_OPTIONS[0].icon;
let activeCategoryPickerName = null;
let firebaseApp = null;
let auth = null;
let db = null;
let currentUser = null;
let authReady = false;
let pendingLoginProfile = null;
let saveTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(nextState) {
  nextState.incomes = (nextState.incomes || []).map(normalizeIncome);
  materializeFixedIncomes(nextState);
  nextState.expenses = nextState.expenses.map((expense) => ({
    ...expense,
    currency: expense.currency || "ARS",
    amountOriginal: expense.amountOriginal ?? expense.amountArs,
    recurring: Boolean(expense.recurring)
  }));
  materializeRecurringExpenses(nextState);
  const expenseCategories = nextState.expenses.map((expense) => expense.category).filter(Boolean);
  const storedProjects = (nextState.projects || []).map((project) => {
    if (typeof project === "string") return { name: project, active: true };
    return { name: project.name, active: project.active !== false };
  });
  const freeloProjects = nextState.freelo
    .map((entry) => ({ name: entry.project, active: true }))
    .filter((project) => project.name);
  nextState.categories = uniqueCategories([...(nextState.categories || []), ...expenseCategories]);
  nextState.projects = uniqueProjects([...storedProjects, ...freeloProjects]);
  return nextState;
}

function normalizeIncome(income) {
  return {
    ...income,
    type: INCOME_TYPES.includes(income.type) ? income.type : "extra",
    detail: income.detail || INCOME_LABELS[income.type] || "Ingreso",
    currency: income.currency || "USD",
    amountOriginal: Number(income.amountOriginal || 0),
    date: income.date || `${monthKey}-01`,
    month: income.month || monthKey
  };
}

function previousMonthKey(key = monthKey) {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(year, month - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthDate(key, day) {
  return `${key}-${String(day).padStart(2, "0")}`;
}

function previousMonthFreeloEntries() {
  const previousKey = previousMonthKey();
  return state.freelo.filter((entry) => entry.date.startsWith(previousKey));
}

function previousMonthFreeloHours(entries = state.freelo) {
  const previousKey = previousMonthKey();
  return entries
    .filter((entry) => entry.date.startsWith(previousKey))
    .reduce((sum, entry) => sum + entry.hours, 0);
}

function freeloIncomeAmount(entries = state.freelo, hourlyRate = FRELO_RATE_USD) {
  return previousMonthFreeloHours(entries) * hourlyRate;
}

function materializeFixedIncomes(nextState) {
  const previousKey = previousMonthKey();
  const defaults = [
    { type: "first_half", date: monthDate(previousKey, 15), amountOriginal: 0, currency: "USD" },
    { type: "first_discount", date: monthDate(previousKey, 15), amountOriginal: 0, currency: "USD" },
    { type: "second_half", date: monthDate(monthKey, 1), amountOriginal: 0, currency: "USD" },
    { type: "second_discount", date: monthDate(monthKey, 1), amountOriginal: 0, currency: "USD" },
    { type: "health", date: monthDate(monthKey, 1), amountOriginal: 0, currency: "USD" },
    {
      type: "freelo",
      date: monthDate(monthKey, 15),
      amountOriginal: freeloIncomeAmount(nextState.freelo, FRELO_RATE_USD),
      currency: "USD",
      hourlyRate: FRELO_RATE_USD,
      info: `${FRELO_RATE_USD} USD/h`
    }
  ];

  defaults.forEach((item) => {
    const exists = nextState.incomes.some((income) => income.month === monthKey && income.type === item.type);
    if (exists) return;
    nextState.incomes.push(normalizeIncome({
      id: crypto.randomUUID(),
      month: monthKey,
      detail: INCOME_LABELS[item.type],
      locked: true,
      ...item
    }));
  });

  const freeloIncome = nextState.incomes.find((income) => income.month === monthKey && income.type === "freelo");
  if (freeloIncome && !freeloIncome.manualOverride) {
    const hourlyRate = Number(freeloIncome.hourlyRate || FRELO_RATE_USD);
    freeloIncome.amountOriginal = freeloIncomeAmount(nextState.freelo, hourlyRate);
    freeloIncome.info = `${formatNumber(hourlyRate)} USD/h`;
  }
}

function materializeRecurringExpenses(nextState) {
  const existingKeys = new Set(nextState.expenses.map((expense) => {
    const recurringRoot = expense.recurringSourceId || expense.id;
    return `${recurringRoot}:${expense.dueDate.slice(0, 7)}`;
  }));
  nextState.expenses
    .filter((expense) => expense.recurring && expense.dueDate.slice(0, 7) < monthKey)
    .forEach((expense) => {
      const recurringRoot = expense.recurringSourceId || expense.id;
      const key = `${recurringRoot}:${monthKey}`;
      if (existingKeys.has(key)) return;
      const day = expense.dueDate.slice(8, 10);
      nextState.expenses.push({
        ...expense,
        id: crypto.randomUUID(),
        dueDate: `${monthKey}-${day}`,
        status: "Pendiente",
        recurringSourceId: recurringRoot,
        paidDate: undefined,
        paidRate: undefined
      });
      existingKeys.add(key);
    });
}

function unique(items) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function uniqueProjects(projects) {
  const byName = new Map();
  projects.forEach((project) => {
    const name = project.name?.trim();
    if (!name || byName.has(name)) return;
    byName.set(name, { name, active: project.active !== false });
  });
  return [...byName.values()];
}

function normalizeCategory(category) {
  if (typeof category === "string") {
    const name = category.trim();
    return { name, icon: DEFAULT_CATEGORY_ICONS[name] || "fa-tag" };
  }
  const name = category.name?.trim();
  const knownIcons = CATEGORY_ICON_OPTIONS.map((option) => option.icon);
  const icon = knownIcons.includes(category.icon) ? category.icon : DEFAULT_CATEGORY_ICONS[name] || CATEGORY_ICON_OPTIONS[0].icon;
  return { name, icon };
}

function uniqueCategories(categories) {
  const byName = new Map();
  categories.map(normalizeCategory).forEach((category) => {
    if (!category.name || byName.has(category.name)) return;
    byName.set(category.name, category);
  });
  return [...byName.values()];
}

function categoryNames() {
  return state.categories.map((category) => category.name);
}

function categoryIcon(name) {
  return state.categories.find((category) => category.name === name)?.icon || DEFAULT_CATEGORY_ICONS[name] || "fa-tag";
}

function chartTone(index) {
  return CHART_TONES[index % CHART_TONES.length];
}

function hasFirebaseConfig() {
  return FIREBASE_REQUIRED_KEYS.every((key) => Boolean(firebaseConfig?.[key]));
}

function cleanupLegacyStorage() {
  try {
    LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch {
    // The app no longer depends on local storage.
  }
}

function userDocRef(user = currentUser) {
  if (!db || !user) return null;
  return doc(db, "users", user.uid);
}

function profileFromFirebaseUser(user) {
  return {
    name: user.displayName || user.email?.split("@")[0] || "Usuario",
    email: user.email || pendingLoginProfile?.email || "usuario@email.com"
  };
}

async function loadRemoteState(user) {
  const profile = pendingLoginProfile || profileFromFirebaseUser(user);
  const snapshot = await getDoc(userDocRef(user));
  const remoteState = snapshot.exists() ? snapshot.data().state : null;
  state = normalizeState({
    ...clone(initialState),
    ...(remoteState || {}),
    user: remoteState?.user || profile
  });
  if (pendingLoginProfile || !remoteState) await saveState({ immediate: true });
  pendingLoginProfile = null;
}

function saveState(options = {}) {
  return saveRemoteState(options);
}

function saveRemoteState(options = {}) {
  if (!currentUser || !db) return Promise.resolve();
  clearTimeout(saveTimer);
  const write = async () => {
    await setDoc(userDocRef(), {
      state: clone(state),
      updatedAt: serverTimestamp()
    }, { merge: true });
  };
  if (options.immediate) return write();
  saveTimer = setTimeout(() => {
    write().catch((error) => console.error("No se pudo guardar en Firestore", error));
  }, 250);
  return Promise.resolve();
}

async function loginUser(name, email) {
  if (!auth) {
    alert("Falta configurar Firebase para poder ingresar.");
    return;
  }
  pendingLoginProfile = {
    name: name.trim() || "Usuario",
    email: email.trim() || "usuario@email.com"
  };
  const credential = await signInAnonymously(auth);
  if (pendingLoginProfile.name) {
    await updateProfile(credential.user, { displayName: pendingLoginProfile.name });
  }
}

async function loginWithGoogle() {
  if (!auth) {
    alert("Falta configurar Firebase para poder ingresar.");
    return;
  }
  pendingLoginProfile = null;
  await signInWithPopup(auth, new GoogleAuthProvider());
}

async function logoutUser() {
  if (auth) await signOut(auth);
  currentUser = null;
  pendingLoginProfile = null;
  state = normalizeState(clone(initialState));
  render();
}

function initFirebase() {
  cleanupLegacyStorage();

  if (!hasFirebaseConfig()) {
    console.warn("Firebase no esta configurado. Completa firebase-config.js para activar Auth y Firestore.");
    authReady = true;
    render();
    return;
  }

  firebaseApp = initializeApp(firebaseConfig);
  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    if (!user) {
      state = normalizeState(clone(initialState));
      authReady = true;
      render();
      return;
    }

    try {
      await loadRemoteState(user);
    } catch (error) {
      console.error("No se pudo cargar Firestore", error);
      state = normalizeState({
        ...clone(initialState),
        user: profileFromFirebaseUser(user)
      });
    }

    authReady = true;
    render();
  });
}

function formatArs(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value);
}

function formatUsd(value) {
  return `US$ ${new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)}`;
}

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] ||= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function parseDate(value) {
  return new Date(`${value}T12:00:00`);
}

function dayDiff(date) {
  return Math.ceil((parseDate(date) - today) / 86400000);
}

function getRateFor(date) {
  const orderedRates = [...state.rates].sort((a, b) => a.date.localeCompare(b.date));
  const exactOrPrevious = orderedRates.filter((rate) => rate.date <= date).at(-1);
  return exactOrPrevious?.rate || orderedRates[0]?.rate || 1;
}

function latestRate() {
  return [...state.rates].sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.rate || 1;
}

function effectiveRate(expense) {
  if (expense.status === "Abonado" && expense.paidRate) return expense.paidRate;
  return expense.manualRate || getRateFor(expense.dueDate);
}

function expenseUsd(expense) {
  if (expense.currency === "USD") return expense.amountOriginal;
  return expense.amountArs / effectiveRate(expense);
}

function expenseArs(expense) {
  if (expense.currency === "USD") return expense.amountOriginal * effectiveRate(expense);
  return expense.amountArs;
}

function incomeRate(income) {
  return income.manualRate || getRateFor(income.date);
}

function incomeUsd(income) {
  if (income.currency === "USD") return income.amountOriginal;
  return income.amountOriginal / incomeRate(income);
}

function incomeArs(income) {
  if (income.currency === "USD") return income.amountOriginal * incomeRate(income);
  return income.amountOriginal;
}

function signedIncomeAmount(type, amount) {
  const value = Number(amount) || 0;
  if (value === 0) return 0;
  if (type === "first_discount" || type === "second_discount") return -Math.abs(value);
  return value;
}

function incomePrimaryAmount(income) {
  return income.currency === "USD" ? formatUsd(income.amountOriginal) : formatArs(income.amountOriginal);
}

function incomeSecondaryAmount(income) {
  return income.currency === "USD" ? formatArs(incomeArs(income)) : formatUsd(incomeUsd(income));
}

function expensePrimaryAmount(expense) {
  return expense.currency === "USD" ? formatUsd(expense.amountOriginal) : formatArs(expenseArs(expense));
}

function expenseSecondaryAmount(expense) {
  return expense.currency === "USD" ? formatArs(expenseArs(expense)) : formatUsd(expenseUsd(expense));
}

function expenseCardMeta(expense) {
  if (expense.status === "Abonado") return expenseSecondaryAmount(expense);
  return `${expenseSecondaryAmount(expense)} - ${dueText(expense)}`;
}

function expenseRateLabel(expense) {
  const rate = effectiveRate(expense);
  const source = expense.status === "Abonado" && expense.paidRate
    ? "cotización al pagar"
    : expense.manualRate
      ? "cotización manual"
      : "cotización prevista";
  return `${formatArs(rate)} - ${source}`;
}

function currentMonthFreelo() {
  return state.freelo.filter((entry) => entry.date.startsWith(monthKey));
}

function sortFreeloEntries(entries) {
  return [...entries].sort((a, b) => {
    const dateOrder = b.date.localeCompare(a.date);
    if (dateOrder) return dateOrder;
    return b.start.localeCompare(a.start);
  });
}

function totals() {
  const totalArs = state.expenses.reduce((sum, item) => sum + expenseArs(item), 0);
  const totalUsd = state.expenses.reduce((sum, item) => sum + expenseUsd(item), 0);
  const paid = state.expenses.filter((item) => item.status === "Abonado");
  const pending = state.expenses.filter((item) => item.status === "Pendiente");
  const paidArs = paid.reduce((sum, item) => sum + expenseArs(item), 0);
  const pendingArs = pending.reduce((sum, item) => sum + expenseArs(item), 0);
  const pendingUsd = pending.reduce((sum, item) => sum + expenseUsd(item), 0);
  const overdue = pending.filter((item) => dayDiff(item.dueDate) < 0);
  const income = incomeTotals();
  const availableUsd = income.totalUsd - totalUsd;
  return { totalArs, totalUsd, paid, pending, paidArs, pendingArs, pendingUsd, overdue, availableUsd, income };
}

function incomeTotals() {
  const totalArs = state.incomes.reduce((sum, income) => sum + incomeArs(income), 0);
  const totalUsd = state.incomes.reduce((sum, income) => sum + incomeUsd(income), 0);
  return { totalArs, totalUsd };
}

function initials(name = "Usuario") {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function showView(target) {
  const isInnerPage = ["projects", "categories", "stats", "notices", "freeloDetail", "expenseDetail", "incomeDetail"].includes(target);
  $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === target));
  $("#appShell").classList.toggle("inner-page", isInnerPage);
  $(".bottom-nav").hidden = isInnerPage;
  const innerNavTargets = {
    expenseDetail: "expenses",
    incomeDetail: "incomes",
    freeloDetail: "freelo",
    projects: "profile",
    categories: "profile",
    stats: "profile",
    notices: "home"
  };
  const navTarget = innerNavTargets[target] || target;
  $$(".bottom-nav button").forEach((button) => button.classList.toggle("active", button.dataset.target === navTarget));
  render();
}

function render() {
  if (!authReady || !state.user) {
    $("#loginScreen").classList.add("active");
    $("#appShell").hidden = true;
    return;
  }

  $("#loginScreen").classList.remove("active");
  $("#appShell").hidden = false;
  $("#helloText").textContent = `Hola, ${state.user.name}`;
  $("#userInitials").textContent = initials(state.user.name);
  $("#monthTitle").textContent = monthLabel;
  $("#profileName").textContent = state.user.name;
  $("#profileEmail").textContent = state.user.email;

  renderDashboard();
  renderExpenses();
  renderExpenseDetail();
  renderIncomes();
  renderIncomeDetail();
  renderFreelo();
  renderFreeloDetail();
  renderStats();
  renderNotices();
  renderCatalogs();
}

function renderExpenseDetail() {
  if (!selectedExpenseId) return;
  const expense = state.expenses.find((item) => item.id === selectedExpenseId);
  if (!expense) return;
  renderExpenseDetailContent(expense);
}

function renderDashboard() {
  const t = totals();
  const avgRate = state.rates.length ? state.rates.reduce((sum, item) => sum + item.rate, 0) / state.rates.length : 0;
  const incomeUsdTotal = Math.max(t.income.totalUsd, 1);
  const percent = Math.max(0, Math.min(100, Math.round((t.availableUsd / incomeUsdTotal) * 100)));
  const nextDue = [...t.pending].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

  $("#availableUsd").textContent = formatUsd(t.availableUsd);
  $("#availableArs").textContent = `${formatArs(t.availableUsd * avgRate)} ARS estimado`;
  $("#freePercent").textContent = `${percent}%`;
  $("#orbMeter").style.background = `conic-gradient(var(--lime) 0 ${percent * 3.6}deg, rgba(255,255,255,.1) ${percent * 3.6}deg 360deg)`;
  $("#totalArs").textContent = formatArs(t.totalArs);
  $("#totalUsd").textContent = formatUsd(t.totalUsd);
  $("#paidArs").textContent = formatArs(t.paidArs);
  $("#paidCount").textContent = `${t.paid.length} pagos`;
  $("#pendingArs").textContent = formatArs(t.pendingArs);
  $("#nextDueText").textContent = nextDue ? dueText(nextDue) : "sin vencimientos";
  $("#overdueCount").textContent = t.overdue.length;
  $("#notificationDot").hidden = t.overdue.length === 0;

  const upcoming = [...t.pending].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5);
  $("#upcomingList").innerHTML = upcoming.map(paymentItem).join("") || emptyState("No quedan pagos pendientes.");
}

function dueText(expense) {
  const diff = dayDiff(expense.dueDate);
  if (diff < 0) return `venció hace ${Math.abs(diff)} día${Math.abs(diff) === 1 ? "" : "s"}`;
  if (diff === 0) return "vence hoy";
  return `vence en ${diff} día${diff === 1 ? "" : "s"}`;
}

function paymentTone(expense) {
  const diff = dayDiff(expense.dueDate);
  if (expense.status === "Abonado") return "paid";
  if (diff < 0) return "danger";
  if (diff <= 3) return "warning";
  return "info";
}

function paymentItem(expense) {
  return `
    <article class="payment-item" data-id="${expense.id}" data-expense-detail="${expense.id}">
      <div class="payment-icon ${paymentTone(expense)}"><i class="fa-solid ${categoryIcon(expense.category)}"></i></div>
      <div>
        <h3>${expense.detail}</h3>
        <p>${expense.category} - ${dueText(expense)}</p>
      </div>
      <strong>${expensePrimaryAmount(expense)}</strong>
    </article>
  `;
}

function renderExpenses() {
  const t = totals();
  $$("#expenseFilter button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.expenseFilter);
  });

  const filtered = state.expenseFilter === "all"
    ? state.expenses
    : state.expenses.filter((expense) => expense.status === state.expenseFilter);
  const summaryArs = filtered.reduce((sum, expense) => sum + expenseArs(expense), 0);
  const summaryUsd = filtered.reduce((sum, expense) => sum + expenseUsd(expense), 0);
  const summaryLabel = state.expenseFilter === "Abonado"
    ? "Ya abonado"
    : state.expenseFilter === "Pendiente"
      ? "Falta pagar"
      : "Total del mes";
  $("#expensesSummaryLabel").textContent = summaryLabel;
  $("#expensesPendingTotal").textContent = formatArs(summaryArs);
  $("#expensesPendingUsd").textContent = formatUsd(summaryUsd);

  const groups = groupBy(filtered, (expense) => expense.category);

  $("#expenseGroups").innerHTML = Object.entries(groups).map(([category, expenses]) => {
    const total = expenses.reduce((sum, expense) => sum + expenseArs(expense), 0);
    return `
      <article>
        <div class="category-row">
          <h2>${category}</h2>
          <strong>${formatArs(total)}</strong>
        </div>
        ${expenses.map((expense) => `
          <button class="compact-card ${expense.status === "Abonado" ? "paid-row" : ""}" data-expense-detail="${expense.id}">
            <span class="card-main">
              <span>${expense.detail}</span>
              <small>${expenseCardMeta(expense)}</small>
            </span>
            <span class="card-side">
              <strong>${expensePrimaryAmount(expense)}</strong>
              <em>${expense.status}</em>
            </span>
          </button>
        `).join("")}
      </article>
    `;
  }).join("") || emptyState("No hay gastos con este filtro.");
}

function sortedIncomes() {
  return [...state.incomes].sort((a, b) => {
    const dateOrder = a.date.localeCompare(b.date);
    if (dateOrder) return dateOrder;
    return INCOME_TYPES.indexOf(a.type) - INCOME_TYPES.indexOf(b.type);
  });
}

function renderIncomes() {
  const totals = incomeTotals();
  $("#incomeTotalPrimary").textContent = formatArs(totals.totalArs);
  $("#incomeTotalSecondary").textContent = formatUsd(totals.totalUsd);
  $("#incomeList").innerHTML = sortedIncomes().map((income) => `
    <button class="payment-item payment-item-button income-row ${income.amountOriginal < 0 ? "discount-row" : ""}" data-income-detail="${income.id}">
      <div class="payment-icon ${income.amountOriginal < 0 ? "danger" : "paid"}"><i class="fa-solid ${incomeIcon(income)}"></i></div>
      <div>
        <h3>${escapeHtml(income.detail)}</h3>
        <p>${income.date} - ${income.currency}${income.info ? ` - ${escapeHtml(income.info)}` : ""}</p>
      </div>
      <strong>${incomePrimaryAmount(income)}</strong>
    </button>
  `).join("") || emptyState("Todavía no hay ingresos cargados.");
}

function incomeIcon(income) {
  if (income.type === "freelo") return "fa-clock";
  if (income.type === "health") return "fa-heart-pulse";
  if (income.type.includes("discount")) return "fa-minus";
  if (income.type === "extra") return "fa-plus";
  return "fa-sack-dollar";
}

function renderIncomeDetail() {
  if (!selectedIncomeId) return;
  const income = state.incomes.find((item) => item.id === selectedIncomeId);
  if (!income) return;
  renderIncomeDetailContent(income);
}

function openIncomeDetail(id) {
  const income = state.incomes.find((item) => item.id === id);
  if (!income) return;
  selectedIncomeId = id;
  isEditingIncome = false;
  renderIncomeDetailContent(income);
  showView("incomeDetail");
}

function renderIncomeDetailContent(income) {
  $("#incomeDetailTitle").textContent = income.detail;
  $("#incomeHeaderDeleteBtn").hidden = income.type !== "extra";
  if (isEditingIncome) {
    const freeloRateFields = income.type === "freelo" ? `
        <div class="time-grid">
          <label>
            Horas mes anterior
            <input name="freeloHours" type="number" value="${previousMonthFreeloHours()}" readonly>
          </label>
          <label>
            Precio hora
            <input name="hourlyRate" type="number" min="0" step="0.01" required value="${income.hourlyRate || FRELO_RATE_USD}">
          </label>
        </div>
    ` : "";
    $("#incomeDetailBody").innerHTML = `
      <form class="form-card glass" data-income-form="${income.id}">
        <label>
          Descripción
          <input name="detail" required value="${escapeHtml(income.detail)}" ${income.type !== "extra" ? "readonly" : ""}>
        </label>
        <div class="time-grid">
          <label>
            Moneda
            <select name="currency">
              <option value="ARS" ${income.currency === "ARS" ? "selected" : ""}>ARS</option>
              <option value="USD" ${income.currency === "USD" ? "selected" : ""}>USD</option>
            </select>
          </label>
          <label>
            Monto
            <input name="amount" type="number" step="0.01" required value="${Math.abs(income.amountOriginal)}">
          </label>
        </div>
        ${freeloRateFields}
        <div class="time-grid">
          <label>
            Fecha de pago
            <input name="date" type="date" required value="${income.date}">
          </label>
          <label>
            Cotización
            <input name="rate" type="number" min="1" step="0.01" value="${incomeRate(income)}">
          </label>
        </div>
        <div class="form-actions">
          <button class="ghost-btn" type="button" data-cancel-income-edit>Cancelar</button>
          <button class="primary-btn" type="submit">Guardar</button>
        </div>
      </form>
    `;
    return;
  }

  $("#incomeDetailBody").innerHTML = `
    <div class="detail-summary">
      <span class="status-chip paid-chip">${income.type === "extra" ? "Extra" : "Fijo"}</span>
      <strong>${incomePrimaryAmount(income)}</strong>
      <p>${incomeSecondaryAmount(income)}</p>
    </div>
    <div class="detail-grid">
      <span>Tipo</span><strong>${escapeHtml(INCOME_LABELS[income.type] || income.type)}</strong>
      <span>Fecha</span><strong>${income.date}</strong>
      <span>Moneda</span><strong>${income.currency}</strong>
      <span>Cotización</span><strong>${formatArs(incomeRate(income))}</strong>
      ${income.info ? `<span>Info</span><strong>${escapeHtml(income.info)}</strong>` : ""}
    </div>
  `;
}

function renderFreelo() {
  const form = $("#freeloForm");
  if (!form.elements.date.value) form.elements.date.value = `${monthKey}-03`;
  const periodEntries = currentMonthFreelo();
  const totalHours = periodEntries.reduce((sum, entry) => sum + entry.hours, 0);
  $("#freeloHours").textContent = `${formatNumber(totalHours)} h`;
  $("#freeloUsd").textContent = formatUsd(totalHours * 10);
  $("#freeloList").innerHTML = sortFreeloEntries(periodEntries)
    .map((entry) => `
      <button class="payment-item payment-item-button" data-freelo-detail="${entry.id}">
        <div class="payment-icon info">${entry.project[0]}</div>
        <div>
          <h3>${entry.task}</h3>
          <p>${entry.project} - ${entry.date} - ${entry.start} a ${entry.end}</p>
        </div>
        <strong>${formatNumber(entry.hours)} h</strong>
      </button>
    `).join("") || emptyState("Todavía no cargaste horas.");
}

function renderFreeloDetail() {
  if (!selectedFreeloId) return;
  const entry = state.freelo.find((item) => item.id === selectedFreeloId);
  if (!entry) return;
  const form = $("#freeloDetailForm");
  const fields = form.elements;
  $("#freeloDetailHours").textContent = `${formatNumber(entry.hours)} h`;
  $("#freeloDetailUsd").textContent = formatUsd(entry.hours * 10);
  $("#freeloDetailProjectSelect").innerHTML = optionsMarkup(unique([...activeProjectNames(), entry.project]));
  fields.task.value = entry.task;
  fields.project.value = entry.project;
  fields.date.value = entry.date;
  fields.start.value = entry.start;
  fields.end.value = entry.end;
}

function renderCatalogs() {
  $("#expenseCategorySelect").innerHTML = optionsMarkup(categoryNames());
  $("#freeloProjectSelect").innerHTML = `<option value="" disabled selected>Seleccionar proyecto</option>${optionsMarkup(activeProjectNames())}`;
  $("#projectList").innerHTML = projectListMarkup(state.projects);
  $("#categoryList").innerHTML = catalogListMarkup("category", state.categories);
  $("#categoryIconPicker").innerHTML = categoryIconPickerMarkup(selectedNewCategoryIcon, {
    action: "new",
    name: "Nueva categoría"
  });
}

function activeProjectNames() {
  const active = state.projects.filter((project) => project.active).map((project) => project.name);
  return active;
}

function optionsMarkup(items, selected = "") {
  if (!items.length) return `<option value="" disabled selected>Sin opciones activas</option>`;
  return items.map((item) => `<option value="${escapeHtml(item)}" ${item === selected ? "selected" : ""}>${escapeHtml(item)}</option>`).join("");
}

function catalogListMarkup(type, items) {
  if (type === "category") {
    return items.map((item) => `
      <article class="settings-item category-item">
        <div class="category-item-head">
          <button class="category-icon-pill category-icon-toggle" type="button" data-category-picker-toggle="${escapeHtml(item.name)}" aria-label="Cambiar icono de ${escapeHtml(item.name)}">
            <i class="fa-solid ${item.icon}"></i>
          </button>
          <input value="${escapeHtml(item.name)}" data-catalog-edit="${type}" data-original="${escapeHtml(item.name)}" aria-label="Editar ${escapeHtml(item.name)}">
          <button class="delete-btn" data-catalog-delete="${type}" data-value="${escapeHtml(item.name)}" aria-label="Eliminar"><i class="fa-solid fa-xmark"></i></button>
        </div>
        ${activeCategoryPickerName === item.name ? categoryIconPickerMarkup(item.icon, { action: "edit", name: item.name }) : ""}
      </article>
    `).join("") || emptyState("No hay items cargados.");
  }
  return items.map((item) => `
    <article class="settings-item">
      <input value="${escapeHtml(item)}" data-catalog-edit="${type}" data-original="${escapeHtml(item)}" aria-label="Editar ${escapeHtml(item)}">
      <button class="delete-btn" data-catalog-delete="${type}" data-value="${escapeHtml(item)}" aria-label="Eliminar"><i class="fa-solid fa-xmark"></i></button>
    </article>
  `).join("") || emptyState("No hay items cargados.");
}

function categoryIconPickerMarkup(selected = "fa-tag", context = { action: "new", name: "" }) {
  const dataAttrs = context.action === "new"
    ? "data-new-category-icon"
    : `data-category-icon-choice="${escapeHtml(context.name)}"`;
  return `
    <div class="icon-picker-grid" role="listbox" aria-label="Icono de ${escapeHtml(context.name || "categoria")}">
      ${CATEGORY_ICON_OPTIONS.map((option) => `
        <button
          class="icon-choice ${option.icon === selected ? "active" : ""}"
          type="button"
          ${dataAttrs}
          data-icon="${option.icon}"
          aria-label="${escapeHtml(option.label)}"
          aria-selected="${option.icon === selected ? "true" : "false"}"
          title="${escapeHtml(option.label)}"
        >
          <i class="fa-solid ${option.icon}"></i>
        </button>
      `).join("")}
    </div>
  `;
}

function projectListMarkup(projects) {
  return projects.map((project) => `
    <article class="settings-item project-item ${project.active ? "" : "paused-item"}">
      <input value="${escapeHtml(project.name)}" data-catalog-edit="project" data-original="${escapeHtml(project.name)}" aria-label="Editar ${escapeHtml(project.name)}">
      <button class="status-btn" data-project-toggle="${escapeHtml(project.name)}" aria-label="${project.active ? "Pausar" : "Reactivar"}">
        ${project.active ? "Pausar" : "Activar"}
      </button>
    </article>
  `).join("") || emptyState("No hay proyectos cargados.");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderStats() {
  $$("#statsMode button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.statsMode);
  });
  const byCategory = Object.entries(groupBy(state.expenses, (expense) => expense.category))
    .map(([category, expenses]) => ({
      category,
      ars: expenses.reduce((sum, item) => sum + expenseArs(item), 0),
      usd: expenses.reduce((sum, item) => sum + expenseUsd(item), 0)
    }));
  const mode = state.statsMode;
  const valueKey = mode === "ars" ? "ars" : "usd";
  const freeloByProject = Object.entries(groupBy(currentMonthFreelo(), (entry) => entry.project))
    .map(([project, entries]) => ({
      category: project,
      usd: entries.reduce((sum, entry) => sum + entry.hours * 10, 0),
      ars: entries.reduce((sum, entry) => sum + entry.hours, 0)
    }));
  const chartItems = mode === "freelo"
    ? freeloByProject
    : byCategory;
  const total = chartItems.reduce((sum, item) => sum + item[valueKey], 0);
  const max = Math.max(...chartItems.map((item) => item[valueKey]), 1);

  $("#chartLabel").textContent = mode === "freelo" ? "Freelo por proyecto" : "Gastos por categoría";
  $("#chartTotal").textContent = mode === "ars" ? formatArs(total) : mode === "freelo" ? formatUsd(total) : formatUsd(total);
  $("#bars").style.setProperty("--chart-count", Math.max(chartItems.length, 1));
  $("#barLabels").style.setProperty("--chart-count", Math.max(chartItems.length, 1));
  $("#bars").innerHTML = chartItems.map((item, index) => `
    <span class="bar-tone-${chartTone(index)}" style="height: ${Math.max(12, (item[valueKey] / max) * 100)}%"></span>
  `).join("");
  $("#barLabels").innerHTML = chartItems.map((item, index) => {
    if (mode === "freelo") return `<span title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span>`;
    return `<span title="${escapeHtml(item.category)}"><i class="fa-solid ${categoryIcon(item.category)} chart-tone-${chartTone(index)}"></i></span>`;
  }).join("");

  if (mode === "freelo") {
    $("#statsList").innerHTML = freeloByProject.map((item) => `
      <article class="payment-item stats-project-card">
        <div class="payment-icon info">${escapeHtml(item.category[0] || "F")}</div>
        <div><h3>${escapeHtml(item.category)}</h3><p>${formatNumber(item.ars)} horas cargadas este mes</p></div>
        <strong>${formatUsd(item.usd)}</strong>
      </article>
    `).join("") || emptyState("No hay horas cargadas este mes.");
    return;
  }

  $("#statsList").innerHTML = chartItems.map((item, index) => `
    <article class="payment-item stats-category-card">
      <div class="payment-icon chart-icon chart-tone-${chartTone(index)}"><i class="fa-solid ${categoryIcon(item.category)}"></i></div>
      <div><h3>${escapeHtml(item.category)}</h3><p>Total gastado</p></div>
      <strong>${mode === "ars" ? formatArs(item.ars) : formatUsd(item.usd)}</strong>
    </article>
  `).join("") || emptyState("No hay gastos para mostrar.");
}

function getNotices() {
  return totals().pending
    .filter((expense) => dayDiff(expense.dueDate) <= 5)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function renderNotices() {
  const target = $("#noticePageList");
  if (!target) return;
  const notices = getNotices();
  target.innerHTML = notices.map(paymentItem).join("") || emptyState("No hay avisos por ahora.");
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(value);
}

function emptyState(text) {
  return `<div class="empty-state">${text}</div>`;
}

function openExpenseDetail(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return;
  selectedExpenseId = id;
  isEditingExpense = false;
  renderExpenseDetailContent(expense);
  showView("expenseDetail");
}

function renderExpenseDetailContent(expense) {
  $("#detailTitle").textContent = expense.detail;
  if (isEditingExpense) {
    const paidDateField = expense.status === "Abonado" ? `
          <label>
            Fecha de pago
            <input name="paidDate" type="date" value="${expense.paidDate || ""}">
          </label>
    ` : "";
    $("#expenseDetailBody").innerHTML = `
      <form class="form-card expense-edit-card glass" id="expenseEditForm" data-expense-form="${expense.id}">
        <label>
          Detalle
          <input name="detail" required value="${escapeHtml(expense.detail)}">
        </label>
        <label>
          Categoria
          <select name="category" required>${optionsMarkup(categoryNames(), expense.category)}</select>
        </label>
        <div class="time-grid">
          <label>
            Moneda
            <select name="currency">
              <option value="ARS" ${expense.currency === "ARS" ? "selected" : ""}>ARS</option>
              <option value="USD" ${expense.currency === "USD" ? "selected" : ""}>USD</option>
            </select>
          </label>
          <label>
            Monto
            <input name="amount" type="number" min="0" step="0.01" required value="${expense.amountOriginal}">
          </label>
        </div>
        <div class="time-grid">
          <label>
            Vence
            <input name="dueDate" type="date" required value="${expense.dueDate}">
          </label>
          ${paidDateField}
        </div>
        <div class="time-grid">
          <label>
            Cotización
            <input name="rate" type="number" min="1" step="0.01" value="${effectiveRate(expense)}">
          </label>
          <label>
            Estado
            <select name="status" data-expense-status-select>
              <option ${expense.status === "Pendiente" ? "selected" : ""}>Pendiente</option>
              <option ${expense.status === "Abonado" ? "selected" : ""}>Abonado</option>
            </select>
          </label>
        </div>
        <div class="form-actions">
          <button class="ghost-btn" type="button" data-cancel-expense-edit>Cancelar</button>
          <button class="primary-btn" type="submit">Guardar</button>
        </div>
      </form>
    `;
    return;
  }

  $("#expenseDetailBody").innerHTML = `
    <div class="detail-summary">
      <span class="status-chip ${expense.status === "Abonado" ? "paid-chip" : ""}">${expense.status}</span>
      <strong>${expensePrimaryAmount(expense)}</strong>
      <p>${expenseSecondaryAmount(expense)}</p>
    </div>
    <div class="detail-grid">
      <span>Categoria</span><strong>${escapeHtml(expense.category)}</strong>
      <span>Vence</span><strong>${expense.dueDate}</strong>
      <span>Moneda</span><strong>${expense.currency}</strong>
      <span>Cotización</span><strong>${expenseRateLabel(expense)}</strong>
      ${expense.paidDate ? `<span>Pagado</span><strong>${expense.paidDate}</strong>` : ""}
    </div>
    <button class="primary-btn" data-mark-paid="${expense.id}">
      ${expense.status === "Abonado" ? "Marcar como pendiente" : "Marcar como pagado"}
    </button>
  `;
}

function toggleExpensePaid(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return;
  if (expense.status === "Abonado") {
    expense.status = "Pendiente";
    delete expense.paidRate;
    delete expense.paidDate;
  } else {
    expense.status = "Abonado";
    expense.paidRate = expense.manualRate || latestRate();
    expense.paidDate = today.toISOString().slice(0, 10);
  }
  saveState();
  render();
  openExpenseDetail(id);
}

function openModal(id) {
  const modal = $(`#${id}`);
  if (modal?.showModal) {
    modal.showModal();
    document.body.classList.add("modal-open");
  }
}

function resetFreeloForm() {
  const form = $("#freeloForm");
  const fields = form.elements;
  form.reset();
  fields.task.value = "";
  fields.project.value = "";
  fields.start.value = "21:00";
  fields.end.value = "23:00";
  fields.date.value = `${monthKey}-03`;
}

function closeModal(id) {
  const modal = $(`#${id}`);
  if (modal?.close) {
    modal.close();
    if (!$$("dialog[open]").length) document.body.classList.remove("modal-open");
  }
}

function calculateHours(start, end) {
  const [startHours, startMinutes] = start.split(":").map(Number);
  const [endHours, endMinutes] = end.split(":").map(Number);
  let startTotal = startHours * 60 + startMinutes;
  let endTotal = endHours * 60 + endMinutes;
  if (endTotal < startTotal) endTotal += 24 * 60;
  return Math.round(((endTotal - startTotal) / 60) * 100) / 100;
}

function addCatalogItem(type, name) {
  const cleaned = name.trim();
  if (!cleaned) return;
  if (type === "project") {
    if (state.projects.some((project) => project.name.toLowerCase() === cleaned.toLowerCase())) return;
    state.projects.push({ name: cleaned, active: true });
  } else {
    const icon = selectedNewCategoryIcon || DEFAULT_CATEGORY_ICONS[cleaned] || CATEGORY_ICON_OPTIONS[0].icon;
    if (state.categories.some((item) => item.name.toLowerCase() === cleaned.toLowerCase())) return;
    state.categories.push({ name: cleaned, icon });
  }
  saveState();
  render();
}

function renameCatalogItem(type, oldName, newName) {
  const cleaned = newName.trim();
  if (!cleaned || cleaned === oldName) {
    renderCatalogs();
    return;
  }

  if (type === "project") {
    if (state.projects.some((project) => project.name.toLowerCase() === cleaned.toLowerCase() && project.name !== oldName)) {
      renderCatalogs();
      return;
    }
    state.projects = state.projects.map((project) => project.name === oldName ? { ...project, name: cleaned } : project);
    state.freelo = state.freelo.map((entry) => entry.project === oldName ? { ...entry, project: cleaned } : entry);
  } else {
    if (state.categories.some((item) => item.name.toLowerCase() === cleaned.toLowerCase() && item.name !== oldName)) {
      renderCatalogs();
      return;
    }
    state.categories = state.categories.map((item) => item.name === oldName ? { ...item, name: cleaned } : item);
    state.expenses = state.expenses.map((expense) => expense.category === oldName ? { ...expense, category: cleaned } : expense);
  }
  saveState();
  render();
}

function deleteCatalogItem(type, value) {
  if (type === "project") return;
  state.categories = state.categories.filter((item) => item.name !== value);
  saveState();
  render();
}

function updateCategoryIcon(name, icon) {
  state.categories = state.categories.map((category) => category.name === name ? { ...category, icon } : category);
  activeCategoryPickerName = null;
  saveState();
  render();
}

function toggleProject(name) {
  state.projects = state.projects.map((project) => {
    if (project.name !== name) return project;
    return { ...project, active: !project.active };
  });
  saveState();
  render();
}

function handleCatalogSubmit(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  addCatalogItem(type, form.elements.name.value);
  form.reset();
  if (type === "category") selectedNewCategoryIcon = CATEGORY_ICON_OPTIONS[0].icon;
  renderCatalogs();
}

function exportBackup() {
  const rows = [
    ["Luma backup", monthKey],
    [],
    ["Gastos"],
    ["Detalle", "Categoría", "Moneda", "Monto original", "Monto ARS", "Monto USD", "Vence", "Estado", "Cotización usada"],
    ...state.expenses.map((expense) => [
      expense.detail,
      expense.category,
      expense.currency,
      expense.amountOriginal,
      expenseArs(expense).toFixed(2),
      expenseUsd(expense).toFixed(2),
      expense.dueDate,
      expense.status,
      getRateFor(expense.dueDate)
    ]),
    [],
    ["Ingresos"],
    ["Detalle", "Tipo", "Moneda", "Monto original", "Monto ARS", "Monto USD", "Fecha", "Cotización usada"],
    ...state.incomes.map((income) => [
      income.detail,
      INCOME_LABELS[income.type] || income.type,
      income.currency,
      income.amountOriginal,
      incomeArs(income).toFixed(2),
      incomeUsd(income).toFixed(2),
      income.date,
      incomeRate(income)
    ]),
    [],
    ["Cotizaciones"],
    ["Fecha", "Cotización"],
    ...state.rates.map((rate) => [rate.date, rate.rate]),
    [],
    ["Freelo"],
    ["Tarea", "Proyecto", "Fecha", "Inicio", "Fin", "Horas", "USD"],
    ...state.freelo.map((entry) => [entry.task, entry.project, entry.date, entry.start, entry.end, entry.hours, entry.hours * 10])
  ];

  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `luma-backup-${monthKey}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("click", (event) => {
  const targetButton = event.target.closest("[data-target]");
  if (targetButton) showView(targetButton.dataset.target);

  const actionButton = event.target.closest("[data-action]");
  if (actionButton?.dataset.action === "expense") openModal("expenseModal");
  if (actionButton?.dataset.action === "income") {
    resetIncomeForm();
    openModal("incomeModal");
  }
  if (actionButton?.dataset.action === "dollar") openModal("dollarModal");
  if (actionButton?.dataset.action === "freelo") {
    resetFreeloForm();
    openModal("freeloModal");
  }
  if (actionButton?.dataset.action === "pending-expenses") {
    state.expenseFilter = "Pendiente";
    saveState();
    showView("expenses");
  }
  if (actionButton?.dataset.action === "export") exportBackup();

  const closeButton = event.target.closest("[data-close]");
  if (closeButton) closeModal(closeButton.dataset.close);

  const newCategoryIcon = event.target.closest("[data-new-category-icon]");
  if (newCategoryIcon) {
    selectedNewCategoryIcon = newCategoryIcon.dataset.icon;
    renderCatalogs();
  }

  const categoryIconChoice = event.target.closest("[data-category-icon-choice]");
  if (categoryIconChoice) {
    updateCategoryIcon(categoryIconChoice.dataset.categoryIconChoice, categoryIconChoice.dataset.icon);
  }

  const categoryPickerToggle = event.target.closest("[data-category-picker-toggle]");
  if (categoryPickerToggle) {
    const name = categoryPickerToggle.dataset.categoryPickerToggle;
    activeCategoryPickerName = activeCategoryPickerName === name ? null : name;
    renderCatalogs();
  }

  const detailTarget = event.target.closest("[data-expense-detail]");
  if (detailTarget) {
    openExpenseDetail(detailTarget.dataset.expenseDetail);
  }

  const incomeDetail = event.target.closest("[data-income-detail]");
  if (incomeDetail) {
    openIncomeDetail(incomeDetail.dataset.incomeDetail);
  }

  const markPaid = event.target.closest("[data-mark-paid]");
  if (markPaid) {
    toggleExpensePaid(markPaid.dataset.markPaid);
  }

  const editExpense = event.target.closest("[data-edit-expense]");
  if (editExpense) {
    isEditingExpense = true;
    renderExpenseDetail();
  }

  const cancelExpenseEdit = event.target.closest("[data-cancel-expense-edit]");
  if (cancelExpenseEdit) {
    isEditingExpense = false;
    renderExpenseDetail();
  }

  const cancelIncomeEdit = event.target.closest("[data-cancel-income-edit]");
  if (cancelIncomeEdit) {
    isEditingIncome = false;
    renderIncomeDetail();
  }

  const deleteExpense = event.target.closest("[data-delete-expense]");
  if (deleteExpense) {
    state.expenses = state.expenses.filter((expense) => expense.id !== deleteExpense.dataset.deleteExpense);
    selectedExpenseId = null;
    saveState();
    showView("expenses");
  }

  const freeloDetail = event.target.closest("[data-freelo-detail]");
  if (freeloDetail) {
    selectedFreeloId = freeloDetail.dataset.freeloDetail;
    showView("freeloDetail");
  }

  const catalogDelete = event.target.closest("[data-catalog-delete]");
  if (catalogDelete) {
    deleteCatalogItem(catalogDelete.dataset.catalogDelete, catalogDelete.dataset.value);
  }

  const projectToggle = event.target.closest("[data-project-toggle]");
  if (projectToggle) {
    toggleProject(projectToggle.dataset.projectToggle);
  }
});

function resetIncomeForm() {
  const form = $("#incomeForm");
  const fields = form.elements;
  form.reset();
  fields.currency.value = "ARS";
  fields.date.value = monthDate(monthKey, 1);
}

$("#expenseHeaderEditBtn").addEventListener("click", () => {
  if (!selectedExpenseId) return;
  isEditingExpense = true;
  renderExpenseDetail();
});

$("#expenseHeaderDeleteBtn").addEventListener("click", () => {
  if (!selectedExpenseId) return;
  state.expenses = state.expenses.filter((expense) => expense.id !== selectedExpenseId);
  selectedExpenseId = null;
  saveState();
  showView("expenses");
});

$("#incomeHeaderEditBtn").addEventListener("click", () => {
  if (!selectedIncomeId) return;
  isEditingIncome = true;
  renderIncomeDetail();
});

$("#incomeHeaderDeleteBtn").addEventListener("click", () => {
  if (!selectedIncomeId) return;
  const income = state.incomes.find((item) => item.id === selectedIncomeId);
  if (!income || income.type !== "extra") return;
  state.incomes = state.incomes.filter((item) => item.id !== selectedIncomeId);
  selectedIncomeId = null;
  saveState();
  showView("incomes");
});

$("#freeloHeaderDeleteBtn").addEventListener("click", () => {
  if (!selectedFreeloId) return;
  state.freelo = state.freelo.filter((entry) => entry.id !== selectedFreeloId);
  selectedFreeloId = null;
  saveState();
  showView("freelo");
});

document.addEventListener("change", (event) => {
  const expenseStatusSelect = event.target.closest("[data-expense-status-select]");
  if (expenseStatusSelect) {
    const form = expenseStatusSelect.closest("[data-expense-form]");
    if (form?.elements.paidDate) {
      form.elements.paidDate.disabled = expenseStatusSelect.value === "Pendiente";
      if (form.elements.paidDate.disabled) form.elements.paidDate.value = "";
    }
    return;
  }

  const catalogEdit = event.target.closest("[data-catalog-edit]");
  if (!catalogEdit) return;
  renameCatalogItem(catalogEdit.dataset.catalogEdit, catalogEdit.dataset.original, catalogEdit.value);
});

document.addEventListener("input", (event) => {
  const hourlyRateInput = event.target.closest("[name='hourlyRate']");
  if (!hourlyRateInput) return;
  const form = hourlyRateInput.closest("[data-income-form]");
  if (!form?.elements.amount) return;
  form.elements.amount.value = freeloIncomeAmount(state.freelo, Number(hourlyRateInput.value) || 0).toFixed(2);
});

document.addEventListener("submit", (event) => {
  const expenseEditForm = event.target.closest("[data-expense-form]");
  if (expenseEditForm) {
    event.preventDefault();
    const expense = state.expenses.find((item) => item.id === expenseEditForm.dataset.expenseForm);
    if (!expense) return;
    const fields = expenseEditForm.elements;
    const currency = fields.currency.value;
    const amountOriginal = Number(fields.amount.value);
    const rate = Number(fields.rate.value) || getRateFor(fields.dueDate.value);
    expense.detail = fields.detail.value.trim();
    expense.category = fields.category.value;
    expense.currency = currency;
    expense.amountOriginal = amountOriginal;
    expense.amountArs = currency === "USD" ? amountOriginal * rate : amountOriginal;
    expense.dueDate = fields.dueDate.value;
    expense.status = fields.status.value;
    expense.manualRate = rate;
    if (expense.status === "Abonado") {
      expense.paidRate = rate;
      expense.paidDate = fields.paidDate?.value || today.toISOString().slice(0, 10);
    } else {
      delete expense.paidRate;
      delete expense.paidDate;
    }
    isEditingExpense = false;
    saveState();
    render();
    openExpenseDetail(expense.id);
    return;
  }

  const incomeEditForm = event.target.closest("[data-income-form]");
  if (incomeEditForm) {
    event.preventDefault();
    const income = state.incomes.find((item) => item.id === incomeEditForm.dataset.incomeForm);
    if (!income) return;
    const fields = incomeEditForm.elements;
    income.detail = income.type === "extra" ? fields.detail.value.trim() : INCOME_LABELS[income.type];
    income.currency = fields.currency.value;
    if (income.type === "freelo") {
      income.hourlyRate = Number(fields.hourlyRate.value) || 0;
      income.amountOriginal = Number(fields.amount.value) || 0;
      income.info = `${formatNumber(income.hourlyRate)} USD/h`;
    } else {
      income.amountOriginal = signedIncomeAmount(income.type, fields.amount.value);
    }
    income.date = fields.date.value;
    income.manualRate = Number(fields.rate.value) || getRateFor(fields.date.value);
    if (income.type === "freelo") income.manualOverride = true;
    isEditingIncome = false;
    saveState();
    render();
    openIncomeDetail(income.id);
    return;
  }

  const rateForm = event.target.closest("[data-rate-form]");
  if (!rateForm) return;
  event.preventDefault();
  const expense = state.expenses.find((item) => item.id === rateForm.dataset.rateForm);
  if (!expense) return;
  expense.manualRate = Number(rateForm.elements.rate.value);
  if (expense.status === "Abonado") expense.paidRate = expense.manualRate;
  saveState();
  render();
  openExpenseDetail(expense.id);
});

$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loginUser($("#loginName").value, $("#loginEmail").value)
    .catch((error) => alert(`No se pudo ingresar: ${error.message}`));
});

$("#googleLogin").addEventListener("click", () => {
  loginWithGoogle()
    .catch((error) => alert(`No se pudo ingresar con Google: ${error.message}`));
});

$("#expenseFilter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.expenseFilter = button.dataset.filter;
  $$("#expenseFilter button").forEach((item) => item.classList.toggle("active", item === button));
  saveState();
  renderExpenses();
});

$("#statsMode").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  state.statsMode = button.dataset.mode;
  $$("#statsMode button").forEach((item) => item.classList.toggle("active", item === button));
  saveState();
  renderStats();
});

$("#projectForm").addEventListener("submit", (event) => handleCatalogSubmit(event, "project"));
$("#categoryForm").addEventListener("submit", (event) => handleCatalogSubmit(event, "category"));

$("#expenseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const currency = fields.currency.value;
  const amountOriginal = Number(fields.amount.value);
  const amountArs = currency === "USD" ? amountOriginal * getRateFor(fields.dueDate.value) : amountOriginal;
  state.expenses.push({
    id: crypto.randomUUID(),
    detail: fields.detail.value.trim(),
    category: fields.category.value,
    currency,
    amountOriginal,
    amountArs,
    dueDate: fields.dueDate.value,
    status: fields.status.value,
    recurring: fields.recurring.checked
  });
  form.reset();
  fields.dueDate.value = "2026-06-10";
  fields.currency.value = "ARS";
  fields.status.value = "Pendiente";
  fields.recurring.checked = false;
  closeModal("expenseModal");
  saveState();
  render();
});

$("#incomeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  state.incomes.push(normalizeIncome({
    id: crypto.randomUUID(),
    month: monthKey,
    type: "extra",
    detail: fields.detail.value.trim(),
    currency: fields.currency.value,
    amountOriginal: Number(fields.amount.value),
    date: fields.date.value,
    manualRate: getRateFor(fields.date.value)
  }));
  closeModal("incomeModal");
  saveState();
  render();
});

$("#dollarForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const existing = state.rates.find((rate) => rate.date === fields.date.value);
  if (existing) existing.rate = Number(fields.rate.value);
  else state.rates.push({ id: crypto.randomUUID(), date: fields.date.value, rate: Number(fields.rate.value) });
  closeModal("dollarModal");
  saveState();
  render();
});

$("#freeloForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = form.elements;
  const hours = calculateHours(fields.start.value, fields.end.value);
  state.freelo.push({
    id: crypto.randomUUID(),
    task: fields.task.value.trim(),
    project: fields.project.value,
    date: fields.date.value,
    start: fields.start.value,
    end: fields.end.value,
    hours
  });
  materializeFixedIncomes(state);
  closeModal("freeloModal");
  saveState();
  render();
});

$("#freeloDetailForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const entry = state.freelo.find((item) => item.id === selectedFreeloId);
  if (!entry) return;
  const fields = event.currentTarget.elements;
  entry.task = fields.task.value.trim();
  entry.project = fields.project.value;
  entry.date = fields.date.value;
  entry.start = fields.start.value;
  entry.end = fields.end.value;
  entry.hours = calculateHours(fields.start.value, fields.end.value);
  materializeFixedIncomes(state);
  saveState();
  render();
});

$("#notificationsBtn").addEventListener("click", () => {
  const notices = getNotices();
  if (window.matchMedia("(max-width: 1023px)").matches) {
    $("#noticePageList").innerHTML = notices.map(paymentItem).join("") || emptyState("No hay avisos por ahora.");
    showView("notices");
    return;
  }
  $("#noticeList").innerHTML = notices.map(paymentItem).join("") || emptyState("No hay avisos por ahora.");
  openModal("noticeModal");
});

$("#exportBtn").addEventListener("click", exportBackup);

$("#logoutBtn").addEventListener("click", () => {
  logoutUser()
    .catch((error) => alert(`No se pudo cerrar sesion: ${error.message}`));
});

$$("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (!$$("dialog[open]").length) document.body.classList.remove("modal-open");
  });
});

$("#expenseForm").elements.dueDate.value = "2026-06-10";
$("#expenseForm").elements.currency.value = "ARS";
$("#incomeForm").elements.date.value = monthDate(monthKey, 1);
$("#incomeForm").elements.currency.value = "ARS";
$("#dollarForm").elements.date.value = "2026-06-02";
$("#dollarForm").elements.rate.value = latestRate();

initFirebase();
