export const GOOGLE_AGENT_API_PREFIX = '/api/google/agent';

export function googleAgentStatusText(status) {
  if (!status) return 'Статус агентского подключения не подтверждён.';
  if (status.requiresClientConfiguration === true || status.configured === false)
    return 'Отдельный OAuth client агента не настроен. Подключение агента недоступно.';
  if (status.authenticated === true)
    return 'Агент Google подключён через отдельную OAuth авторизацию.';
  return 'Агент Google не подключён. Требуется отдельная авторизация агента.';
}
