import { List } from 'immutable';
import { actions as notifActions } from 'redux-notifications';
import { serializeValues } from 'Lib/serializeEntryValues';
import { currentBackend } from 'Backends/backend';
import { getIntegrationProvider } from 'Integrations';
import { getAsset, selectIntegration } from 'Reducers';
import { selectFields } from 'Reducers/collections';
import { collectionEntriesCursorKey } from 'Reducers/cursors';
import { validateCursor, invalidCursorError } from 'ValueObjects/Cursor';
import { createEntry } from 'ValueObjects/Entry';
import ValidationErrorTypes from 'Constants/validationErrorTypes';
import isArray from 'lodash/isArray';

const { notifSend } = notifActions;

/*
 * Contant Declarations
 */
export const ENTRY_REQUEST = 'ENTRY_REQUEST';
export const ENTRY_SUCCESS = 'ENTRY_SUCCESS';
export const ENTRY_FAILURE = 'ENTRY_FAILURE';

export const ENTRIES_REQUEST = 'ENTRIES_REQUEST';
export const ENTRIES_SUCCESS = 'ENTRIES_SUCCESS';
export const ENTRIES_FAILURE = 'ENTRIES_FAILURE';

export const DRAFT_CREATE_FROM_ENTRY = 'DRAFT_CREATE_FROM_ENTRY';
export const DRAFT_CREATE_EMPTY = 'DRAFT_CREATE_EMPTY';
export const DRAFT_DISCARD = 'DRAFT_DISCARD';
export const DRAFT_CHANGE = 'DRAFT_CHANGE';
export const DRAFT_CHANGE_FIELD = 'DRAFT_CHANGE_FIELD';
export const DRAFT_VALIDATION_ERRORS = 'DRAFT_VALIDATION_ERRORS';

export const ENTRY_PERSIST_REQUEST = 'ENTRY_PERSIST_REQUEST';
export const ENTRY_PERSIST_SUCCESS = 'ENTRY_PERSIST_SUCCESS';
export const ENTRY_PERSIST_FAILURE = 'ENTRY_PERSIST_FAILURE';

export const ENTRY_DELETE_REQUEST = 'ENTRY_DELETE_REQUEST';
export const ENTRY_DELETE_SUCCESS = 'ENTRY_DELETE_SUCCESS';
export const ENTRY_DELETE_FAILURE = 'ENTRY_DELETE_FAILURE';

/*
 * Simple Action Creators (Internal)
 * We still need to export them for tests
 */
export function entryLoading(collection, slug) {
  return {
    type: ENTRY_REQUEST,
    payload: {
      collection: collection.get('name'),
      slug,
    },
  };
}

export function entryLoaded(collection, entry) {
  return {
    type: ENTRY_SUCCESS,
    payload: {
      collection: collection.get('name'),
      entry,
    },
  };
}

export function entryLoadError(error, collection, slug) {
  return {
    type: ENTRY_FAILURE,
    payload: {
      error,
      collection: collection.get('name'),
      slug,
    },
  };
}

export function entriesLoading(collection) {
  return {
    type: ENTRIES_REQUEST,
    payload: {
      collection: collection.get('name'),
    },
  };
}

export function entriesLoaded(collection, entries, pagination, cursor = null) {
  return {
    type: ENTRIES_SUCCESS,
    payload: {
      collection: collection.get('name'),
      entries,
      page: pagination,
      // If the backend returns a cursor, we add it to the action. It
      // will be processed by the `cursors` reducer.
      ...(cursor ? { cursor } : {})
    }
  };
}

export function entriesFailed(collection, error) {
  return {
    type: ENTRIES_FAILURE,
    error: 'Failed to load entries',
    payload: error.toString(),
    meta: { collection: collection.get('name') },
  };
}

export function entryPersisting(collection, entry) {
  return {
    type: ENTRY_PERSIST_REQUEST,
    payload: {
      collectionName: collection.get('name'),
      entrySlug: entry.get('slug'),
    },
  };
}

export function entryPersisted(collection, entry, slug) {
  return {
    type: ENTRY_PERSIST_SUCCESS,
    payload: {
      collectionName: collection.get('name'),
      entrySlug: entry.get('slug'),

      /**
       * Pass slug from backend for newly created entries.
       */
      slug,
    },
  };
}

export function entryPersistFail(collection, entry, error) {
  return {
    type: ENTRY_PERSIST_FAILURE,
    error: 'Failed to persist entry',
    payload: {
      collectionName: collection.get('name'),
      entrySlug: entry.get('slug'),
      error: error.toString(),
    },
  };
}

export function entryDeleting(collection, slug) {
  return {
    type: ENTRY_DELETE_REQUEST,
    payload: {
      collectionName: collection.get('name'),
      entrySlug: slug,
    },
  };
}

export function entryDeleted(collection, slug) {
  return {
    type: ENTRY_DELETE_SUCCESS,
    payload: {
      collectionName: collection.get('name'),
      entrySlug: slug,
    },
  };
}

export function entryDeleteFail(collection, slug, error) {
  return {
    type: ENTRY_DELETE_FAILURE,
    payload: {
      collectionName: collection.get('name'),
      entrySlug: slug,
      error: error.toString(),
    },
  };
}

export function emptyDraftCreated(entry) {
  return {
    type: DRAFT_CREATE_EMPTY,
    payload: entry,
  };
}
/*
 * Exported simple Action Creators
 */
export function createDraftFromEntry(entry, metadata) {
  return {
    type: DRAFT_CREATE_FROM_ENTRY,
    payload: { entry, metadata },
  };
}


export function discardDraft() {
  return {
    type: DRAFT_DISCARD,
  };
}

export function changeDraft(entry) {
  return {
    type: DRAFT_CHANGE,
    payload: entry,
  };
}

export function changeDraftField(field, value, metadata) {
  return {
    type: DRAFT_CHANGE_FIELD,
    payload: { field, value, metadata },
  };
}

export function changeDraftFieldValidation(field, errors) {
  return {
    type: DRAFT_VALIDATION_ERRORS,
    payload: { field, errors },
  };
}


/*
 * Exported Thunk Action Creators
 */

export function loadEntry(collection, slug) {
  return (dispatch, getState) => {
    const state = getState();
    const backend = currentBackend(state.config);
    dispatch(entryLoading(collection, slug));
    return backend.getEntry(collection, slug)
      .then(loadedEntry => {
        return dispatch(entryLoaded(collection, loadedEntry))
      })
      .catch((error) => {
        console.error(error);
        dispatch(notifSend({
          message: `Failed to load entry: ${ error.message }`,
          kind: 'danger',
          dismissAfter: 8000,
        }));
        dispatch(entryLoadError(error, collection, slug));
      });
  };
}

export function loadEntries(collection, page = 0) {
  return (dispatch, getState) => {
    if (collection.get('isFetching')) {
      return;
    }
    const state = getState();
    const backend = currentBackend(state.config);
    const integration = selectIntegration(state, collection.get('name'), 'listEntries');
    const provider = integration ? getIntegrationProvider(state.integrations, backend.getToken, integration) : backend;
    dispatch(entriesLoading(collection));
    provider.listEntries(collection, page)
    // Validate the cursor if it exists to ensure it has the correct
    // structure.
    .then(response => ((!response.cursor) || validateCursor(response.cursor)
      ? response
      : Promise.reject(invalidCursorError(response.cursor))))
    .then(response => dispatch(entriesLoaded(collection, response.entries.reverse(), response.pagination, response.cursor)))
    .catch(err => {
      dispatch(notifSend({
        message: `Failed to load entries: ${ err }`,
        kind: 'danger',
        dismissAfter: 8000,
      }));
      return Promise.reject(dispatch(entriesFailed(collection, err)))
    });
  };
}

export function createEmptyDraft(collection) {
  return (dispatch) => {
    const dataFields = {};
    collection.get('fields', List()).forEach((field) => {
      dataFields[field.get('name')] = field.get('default');
    });
    const newEntry = createEntry(collection.get('name'), '', '', { data: dataFields });
    dispatch(emptyDraftCreated(newEntry));
  };
}

export function persistEntry(collection) {
  return (dispatch, getState) => {
    const state = getState();
    const entryDraft = state.entryDraft;
    const fieldsErrors = entryDraft.get('fieldsErrors');

    // Early return if draft contains validation errors
    if (!fieldsErrors.isEmpty()) {
      const hasPresenceErrors = fieldsErrors
        .some(errors => errors.some(error => error.type && error.type === ValidationErrorTypes.PRESENCE));

      if (hasPresenceErrors) {
        dispatch(notifSend({
          message: 'Oops, you\'ve missed a required field. Please complete before saving.',
          kind: 'danger',
          dismissAfter: 8000,
        }));
      }

      return Promise.reject();
    }

    const backend = currentBackend(state.config);
    const assetProxies = entryDraft.get('mediaFiles').map(path => getAsset(state, path));
    const entry = entryDraft.get('entry');

    /**
     * Serialize the values of any fields with registered serializers, and
     * update the entry and entryDraft with the serialized values.
     */
    const fields = selectFields(collection, entry.get('slug'));
    const serializedData = serializeValues(entryDraft.getIn(['entry', 'data']), fields);
    const serializedEntry = entry.set('data', serializedData);
    const serializedEntryDraft = entryDraft.set('entry', serializedEntry);
    dispatch(entryPersisting(collection, serializedEntry));
    return backend
      .persistEntry(state.config, collection, serializedEntryDraft, assetProxies.toJS())
      .then(slug => {
        dispatch(notifSend({
          message: 'Entry saved',
          kind: 'success',
          dismissAfter: 4000,
        }));
        dispatch(entryPersisted(collection, serializedEntry, slug))
      })
      .catch((error) => {
        console.error(error);
        dispatch(notifSend({
          message: `Failed to persist entry: ${ error }`,
          kind: 'danger',
          dismissAfter: 8000,
        }));
        return Promise.reject(dispatch(entryPersistFail(collection, serializedEntry, error)));
      });
  };
}

export function deleteEntry(collection, slug) {
  return (dispatch, getState) => {
    const state = getState();
    const backend = currentBackend(state.config);

    dispatch(entryDeleting(collection, slug));
    return backend.deleteEntry(state.config, collection, slug)
    .then(() => {
      return dispatch(entryDeleted(collection, slug));
    })
    .catch((error) => {
      dispatch(notifSend({
        message: `Failed to delete entry: ${ error }`,
        kind: 'danger',
        dismissAfter: 8000,
      }));
      console.error(error);
      return Promise.reject(dispatch(entryDeleteFail(collection, slug, error)));
    });
  };
}
