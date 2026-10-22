# Подключение Google Docs

Учётные данные создаются в вашем Google Cloud проекте. Пароль Google и секрет клиента не отправляйте в чат.

1. Откройте [Google Cloud Console](https://console.cloud.google.com/), создайте или выберите проект и включите **Google Docs API** и **Google Drive API**.
2. В Google Auth Platform заполните Branding и Audience. Для личной проверки выберите External / Testing и добавьте свой Google-аккаунт в Test users. Инструкция: [экран согласия](https://developers.google.com/workspace/guides/configure-oauth-consent).
3. В Clients создайте OAuth client типа **Web application**. Добавьте Authorized redirect URI, который показывает TaleWisp. При стандартном локальном запуске это `http://127.0.0.1:8787/api/google/callback`. Адрес должен совпадать полностью, включая порт и путь.
4. В TaleWisp откройте **Google Docs → Настроить Google OAuth**, введите Client ID и Client secret и сохраните. Затем нажмите подключение и завершите согласие в Google.

Клиент сохраняет настройки в зашифрованном локальном хранилище; поле секрета очищается после сохранения. Доступы: идентификация, Google Docs и чтение Drive. Доступ к почте не запрашивается. Выданные разрешения можно отозвать в Google-аккаунте.

Для сервера настройте HTTPS и `TALEWISP_WEB_ORIGIN`, зарегистрируйте показанный сервером callback. Клиент Google OAuth и подписка ChatGPT — отдельные подключения. Переменные `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`, если заданы, имеют приоритет над формой.

Официальные инструкции: [создание credentials](https://developers.google.com/workspace/guides/create-credentials), [серверный OAuth](https://developers.google.com/identity/protocols/oauth2/web-server). Реальный обмен токенами, чтение документа и сохранение нативных предложений проверяются только после подключения вашего аккаунта.
