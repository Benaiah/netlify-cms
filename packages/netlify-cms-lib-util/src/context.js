import { Map } from "immutable";
import { assign } from "lodash";
import semaphore from "semaphore";
import localForage from "./localForage";
import unsentRequest from "./unsentRequest";
const { performRequest } = unsentRequest;

/*
  Context is a data container used to provide information to a backend
  that is state-dependent. It should be retrievable without the
  arguments to the specific call, and it should be as flat as possible
  so that it is easy to extend.

  The normal pattern of a backend function will be to take a context
  followed by other arguments, use destructuring -
  `const { branch } = ctx;` - to retrieve variables from the context,
  and modify the context in sub-calls if necessary as follows:
  `funcRequiringContext({...ctx, custom: "setting"}, ...arguments)`.
*/

export const getContextFor = (name, extraContext = {}) => ({
  apiRoot: "",
  branch: "master",
  commitAuthor: { name: "", email: "" },
  config: Map(), // config.yml
  proxied: false,
  editorialWorkflow: false,

  // getAuthInfo should return a promise that resolves to the
  getAuthInfo: () => Promise.resolve(),

  performRequest,

  // set/getCacheItem is for persisting values between sessions (in
  // localStorage)
  setCacheItem: (key, val) =>
    localForage.setItem(`backends.${name}.${key}`, val),
  getCacheItem: key => localForage.getItem(`backends.${name}.${key}`),

  ...extraContext
});
