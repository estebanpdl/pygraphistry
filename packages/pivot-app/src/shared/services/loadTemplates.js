import { Observable } from 'rxjs';
import SimpleServiceWithCache from './support/simpleServiceWithCache.js';
import { createTemplateModel } from '../models';
import * as templates from './templates';

export function templateStore(loadApp) {
    const templatesMap = listTemplates();

    function loadTemplateById(templateId) {
        return Observable.of(
            templatesMap[templateId]
        );
    }

    const service = new SimpleServiceWithCache({
        loadApp: loadApp,
        resultName: 'template',
        loadById: loadTemplateById,
        createModel: createTemplateModel,
        cache: {}
    });

    function loadTemplatesById({templateIds}) {
        return service.loadByIds(templateIds);
    }

    return {
        loadTemplatesById: loadTemplatesById
    };
}

export function listTemplates() {
    return Object.values(templates)
        .reduce(function(templatesById, template) {
            templatesById[template.id] = template;
            return templatesById;
        }, {});
}
