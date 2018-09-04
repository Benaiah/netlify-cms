import { get } from "lodash";
import semaphore from "semaphore";
import { fromJS } from "immutable";
import { fileExtension } from "./path";
import { CURSOR_COMPATIBILITY_SYMBOL } from "./Cursor";
import { getContextFor } from "./context";
import { performRequest, withHeaders } from "./unsentRequest";

export const filterByPropExtension = (extension, propName) => arr =>
  arr.filter(el => fileExtension(get(el, propName)) === extension);

const catchFormatErrors = (format, formatter) => res => {
  try {
    return formatter(res);
  } catch (err) {
    throw new Error(
      `Response cannot be parsed into the expected format (${format}): ${
        err.message
      }`
    );
  }
};

const responseFormatters = fromJS({
  json: async res => {
    const contentType = res.headers.get("Content-Type");
    if (
      !contentType.startsWith("application/json") &&
      !contentType.startsWith("text/json")
    ) {
      throw new Error(`${contentType} is not a valid JSON Content-Type`);
    }
    return res.json();
  },
  text: async res => res.text(),
  blob: async res => res.blob()
}).mapEntries(([format, formatter]) => [
  format,
  catchFormatErrors(format, formatter)
]);

export const parseResponse = async (
  res,
  { expectingOk = true, format = "text" } = {}
) => {
  if (expectingOk && !res.ok) {
    throw new Error(
      `Expected an ok response, but received an error status: ${res.status}.`
    );
  }
  const formatter = responseFormatters.get(format, false);
  if (!formatter) {
    throw new Error(`${format} is not a supported response format.`);
  }
  const body = await formatter(res);
  return body;
};

export const responseParser = options => res => parseResponse(res, options);

const synchronousAPIFunctions = {
  getContext: true,
  getAuthComponent: true
};

const defaultMaxDownloads = 10;

// wrapper for the new backend API
export const getWrapperClassForNewAPI = (
  unhandledAPI,
  { name: nameOverride, maxDownloads = defaultMaxDownloads } = {}
) => {
  const name = nameOverride || unhandledAPI.name || "unknown";
  const handler = err => {
    console.error(err);
    debugger;
  };
  const api = Object.entries(unhandledAPI).reduce((handledAPI, [k, v]) => {
    const newAPIFn = !synchronousAPIFunctions[k]
      ? async (...args) => {
          try {
            return await v(...args);
          } catch (err) {
            return handler(err);
          }
        }
      : v;
    return { ...handledAPI, [k]: newAPIFn };
  }, {});

  return class {
    constructor(config, options = {}) {
      this.requestSemaphore = semaphore(maxDownloads);
      this.backendData = {};
      this.config = config;
      this.authenticationPromise = new Promise((resolve, reject) => {
        this.resolveAuthenticationPromise = resolve;
        this.rejectAuthenticationPromise = reject;
      });
    }

    request(req) {
      const sem = this.requestSemaphore;
      return new Promise((resolve, reject) => {
        sem.take(async () => {
          try {
            const response = await performRequest(req);
            sem.leave();
            resolve(response);
          } catch (err) {
            sem.leave();
            reject(err);
          }
        });
      });
    }

    getContext(extraContext = {}) {
      // getContextFor allows us to pass a namespace into the context.
      const defaultContext = getContextFor(name, {
        config: this.config,
        getCredentials: this.getCredentials.bind(this),
	request: this.request.bind(this),
        ...extraContext
      });
      return api.getContext(defaultContext);
    }

    authComponent = api.getAuthComponent;

    authenticate(credentials) {
      const getCredentials = () => Promise.resolve(credentials);
      const ctx = this.getContext({ getCredentials });
      return (api.checkCredentials
        ? api.checkCredentials(ctx, credentials)
        : Promise.resolve(credentials)
      ).then(credentials => {
        this.resolveAuthenticationPromise(credentials);
        return credentials;
      });
    }
    restoreUser(credentials) {
      return this.authenticate(credentials);
    }

    getCredentials() {
      return this.authenticationPromise;
    }

    logout() {
      this.authenticationPromise = Promise.resolve(null);
    }

    // this API does not generalize, and only exists for backwards compatibility
    getToken() {
      return this.authenticationPromise.then(({ token }) => token);
    }

    entriesByFolder(collection, extension) {
      const ctx = this.getContext();
      return api
        .getCollectionEntries(ctx, collection)
        .then(({ entries, cursor }) => {
          entries[CURSOR_COMPATIBILITY_SYMBOL] = cursor;
          return entries;
        });
    }
    entriesByFiles(collection) {
      const ctx = this.getContext();
      return api
        .getCollectionEntries(ctx, collection)
        .then(({ entries }) => entries);
    }

    allEntriesByFolder(collection, extension) {
      const ctx = this.getContext();
      return api.getAllCollectionEntries(ctx, collection);
    }

    getEntry(collection, slug, path) {
      const ctx = this.getContext();
      return api.getEntry(ctx, collection, path);
    }

    getMedia() {
      const ctx = this.getContext();
      return api.getMedia(ctx);
    }

    persistEntry(entry, mediaFiles, options) {
      const ctx = this.getContext();
      return api.persistEntry(ctx, entry, options);
    }

    persistMedia(entry, mediaFile, options) {
      const ctx = this.getContext();
      return api.persistMedia(ctx, mediaFile, options);
    }

    traverseCursor(cursor, action) {
      const ctx = this.getContext();
      return api.traverseCursor(ctx, cursor, action);
    }
  };
};
