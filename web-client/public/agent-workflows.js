const LABELS = {
  ordinary_writing: 'Письмо',
  continuation: 'Продолжить сцену',
  revision: 'Предложить правку',
  canon_research: 'Исследовать канон или источники',
  knowledge_audit: 'Проверить хронологию и знания персонажей',
  writing: 'Писать',
  continue: 'Продолжить',
  revise: 'Предложить правку',
  research: 'Исследовать',
  knowledge: 'Работа с базой знаний',
  onboarding: 'Знакомство с автором',
  import: 'Импорт книг',
  series_base: 'Создать базу серии по книгам',
  google_workspace: 'Google для авторской работы',
  storyart: 'Передача задачи в StoryArt',
  code_review: 'Независимая проверка кода',
  calibration: 'Калибровка стиля',
  roleplay: 'Ролевая игра'
};

const STATUS_LABELS = {
  available: 'Доступно',
  unavailable: 'Недоступно',
  gated: 'Нужны условия',
  ready: 'Доступно',
  pending: 'Ожидает запуска',
  thread_starting: 'Создаётся поток',
  thread_ready: 'Поток готов',
  turn_starting: 'Запускается запрос',
  running: 'Выполняется',
  cancel_requested: 'Остановка запрошена',
  cancelling: 'Ожидает подтверждения остановки',
  interrupted: 'Прервано',
  incomplete: 'Не завершено',
  completed: 'Завершено',
  cancelled: 'Остановлено',
  canceled: 'Остановлено',
  failed: 'Ошибка'
};

const list = value => Array.isArray(value) ? value : [];
const records = value => Array.isArray(value)
  ? value
  : value && typeof value === 'object'
    ? Object.entries(value).map(([id, item]) => item && typeof item === 'object' ? { id, ...item } : null).filter(Boolean)
    : [];
const clean = value => typeof value === 'string' ? value.trim() : '';
const textList = value => list(value).map(item => typeof item === 'string' ? item : clean(item?.title || item?.label || item?.name || item?.id)).filter(Boolean);
const availabilityOf = item => {
  if (typeof item?.available === 'boolean') return item.available ? 'available' : 'unavailable';
  const value = clean(item?.availability || item?.status).toLowerCase();
  if (['available', 'ready', 'enabled'].includes(value)) return 'available';
  if (['gated', 'blocked', 'requires_setup'].includes(value)) return 'gated';
  if (['unavailable', 'disabled', 'unsupported'].includes(value)) return 'unavailable';
  return value || 'unknown';
};

export function buildWorkflowViewModel(status = {}) {
  const rawSkills = records(status?.skills).filter(item => item && typeof item === 'object');
  const isResourceIndex = rawSkills.some(item => /\.md$/i.test(clean(item.id)) || /\/references\//i.test(clean(item.id)));
  const skillEntries = isResourceIndex
    ? rawSkills.filter(item => /\/SKILL\.md$/i.test(clean(item.id)) || item.kind === 'skill')
    : rawSkills;
  const skills = skillEntries.map(item => ({
    id: clean(item.id),
    title: clean(item.title) || clean(item.name) || clean(item.id) || 'Навык',
    description: clean(item.description),
    availability: availabilityOf(item),
    gates: textList(item.gates || item.dependencies),
    transports: textList(item.transports || item.transportAvailability)
  }));
  const scenarios = records(status?.scenarios).filter(item => item && typeof item === 'object').map(item => {
    const id = clean(item.id);
    return {
      id,
      title: LABELS[id] || clean(item.title) || id || 'Сценарий',
      availability: availabilityOf(item),
      gates: textList(item.gates || item.dependencies),
      optIn: item.optIn === true || ['calibration', 'roleplay'].includes(id)
    };
  }).filter(item => item.id);
  const delegationStatus = status?.delegations;
  const delegationEntries = Array.isArray(delegationStatus)
    ? delegationStatus
    : [...list(delegationStatus?.recent), ...list(delegationStatus?.active)];
  const delegations = delegationEntries.filter(item => item && typeof item === 'object').slice(-6).map(item => ({
    id: clean(item.id),
    role: clean(item.role) || 'Агент',
    model: clean(item.model),
    effort: clean(item.effort),
    threadId: clean(item.threadId),
    phase: clean(item.phase),
    status: clean(item.status).toLowerCase() || 'unknown',
    startedAt: clean(item.startedAt),
    completedAt: clean(item.completedAt),
    result: clean(item.result),
    error: clean(item.error)
  }));
  return { contractVersion: clean(status?.contractVersion), skills, scenarios, delegations };
}

export function availabilityLabel(value) {
  return STATUS_LABELS[value] || 'Статус уточняется';
}

export function delegationStatusLabel(value) {
  return STATUS_LABELS[value] || 'Состояние обновлено';
}

export function scenarioCanRun(scenario) {
  return scenario?.availability === 'available';
}

export function buildAgentMessagePayload(text, mode, reviewerRequested = false) {
  const request = reviewerRequested
    ? text + '\n\nОтдельная просьба: после ответа проведи одну независимую проверку результата и сообщи только о блокирующих проблемах.'
    : text;
  return { text: request, ...(mode ? { mode } : {}) };
}

