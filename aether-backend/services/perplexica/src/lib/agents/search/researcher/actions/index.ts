import academicSearchAction from './academicSearch';
import doneAction from './done';
import planAction from './plan';
import ActionRegistry from './registry';
import scrapeURLAction from './scrapeURL';
import socialSearchAction from './socialSearch';
import legalSearchAction from './legalSearch';
import uploadsSearchAction from './uploadsSearch';
import webSearchAction from './webSearch';
import newsSearchAction from './newsSearch';

ActionRegistry.register(webSearchAction);
ActionRegistry.register(doneAction);
ActionRegistry.register(planAction);
ActionRegistry.register(scrapeURLAction);
ActionRegistry.register(uploadsSearchAction);
ActionRegistry.register(academicSearchAction);
ActionRegistry.register(socialSearchAction);
ActionRegistry.register(legalSearchAction);
ActionRegistry.register(newsSearchAction);

export { ActionRegistry };
