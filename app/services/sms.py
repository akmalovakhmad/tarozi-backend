"""Отправка SMS. Сейчас это заглушка: сообщение пишется в лог.
Чтобы слать по-настоящему, замените тело send_sms вызовом API вашего SMS-провайдера
(например, Eskiz или Play Mobile в Узбекистане) и положите ключ в .env."""
import logging

log = logging.getLogger("sms")


def send_sms(phone: str, text: str) -> bool:
    log.info("SMS на %s: %s", phone, text)
    return True
