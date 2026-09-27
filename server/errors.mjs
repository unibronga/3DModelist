// Ошибка для человека: код + подстановки. Текст на нужном языке собирает
// страница по ключу err.<code>; message — запасной русский текст для логов.

export class UserError extends Error {
  constructor(code, params = {}, message = code) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

// Тело ответа с ошибкой: страница покажет t('err.' + code), а если такого
// ключа нет — сам текст.
export const errBody = (e) => ({ error: String(e?.message || e), code: e?.code, params: e?.params });
