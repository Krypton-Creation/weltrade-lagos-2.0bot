import { Context } from 'grammy';
import { config } from '../config';

export function isAdminChat(chatId: number | undefined): boolean {
  return chatId === config.adminChatId;
}

export function isAdminUser(userId: number | undefined): boolean {
  return userId !== undefined && config.adminUserIds.includes(userId);
}

export function isAuthorizedAdmin(ctx: Context): boolean {
  return isAdminChat(ctx.chat?.id) && isAdminUser(ctx.from?.id);
}
