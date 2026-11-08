export enum QueueName {
  ThumbnailGeneration = 'thumbnailGeneration',
  MetadataExtraction = 'metadataExtraction',
  Notification = 'notifications',
}
// Ловушки: статусы и имена задач не очереди.
export enum QueueJobStatus { Active = 'active', Failed = 'failed' }
export enum JobName { SendMail = 'SendMail' }
export const enum MailQueues { Digest = 'mail-digest' }
