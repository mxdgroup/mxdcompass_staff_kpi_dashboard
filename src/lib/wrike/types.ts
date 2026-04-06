// Wrike API v4 type definitions

export interface WrikeTaskDates {
  type?: string;
  duration?: number;
  start?: string;
  due?: string;
}

export interface WrikeCustomField {
  id: string;
  value?: string;
}

export interface WrikeTask {
  id: string;
  title: string;
  status: string;
  customStatusId?: string;
  importance: string;
  createdDate: string;
  updatedDate: string;
  completedDate?: string;
  dates: WrikeTaskDates;
  responsibleIds: string[];
  parentIds: string[];
  customFields: WrikeCustomField[];
  permalink: string;
  briefDescription?: string;
}

export interface WrikeComment {
  id: string;
  authorId: string;
  text: string;
  taskId: string;
  createdDate: string;
}

export interface WrikeTimelog {
  id: string;
  taskId: string;
  userId: string;
  hours: number;
  trackedDate: string;
  comment?: string;
}

export interface WrikeCustomStatus {
  id: string;
  name: string;
  color: string;
  group: string;
}

export interface WrikeWorkflow {
  id: string;
  name: string;
  customStatuses: WrikeCustomStatus[];
}

export interface WrikeContact {
  id: string;
  firstName: string;
  lastName: string;
}

export interface WrikeApiResponse<T> {
  kind: string;
  data: T[];
  nextPageToken?: string;
}
