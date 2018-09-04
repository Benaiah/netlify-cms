import { isError, map, partial, result } from "lodash/fp";
import { List, Map } from "immutable";
import {
  getWrapperClassForNewAPI,
  responseParser,
  unsentRequest,
  Cursor
} from "netlify-cms-lib-util";

const {
  withDefaultHeaders,
  withHeaders,
  withMethod,
  withParams,
  withRoot,
  withTimestamp
} = unsentRequest;

import AuthenticationPage from "./AuthenticationPage";

const buildContext = defaultContext => {
  const { config } = defaultContext;
  const repo = config.getIn(["backend", "repo"]);
  return {
    ...defaultContext,
    apiRoot: "https://gitlab.com/api/v4",
    repo,
    repoURL: `/projects/${encodeURIComponent(repo)}`,
    branch: config.getIn(["backend", "branch"], "master")
  };
};

const getContext = defaultContext => {
  const ctx = buildContext(defaultContext);
  const { editorialWorkflow } = ctx;
  if (editorialWorkflow) {
    throw new Error(
      "The GitLab backend does not support the Editorial Workflow."
    );
  }
  return ctx;
};

const authorizeRequest = async (ctx, req) => {
  const { getCredentials } = ctx;
  const credentials = await getCredentials();
  const { token } = credentials;
  return withHeaders({ Authorization: `Bearer ${token}` }, req);
};

const prepareRequest = async (ctx, req) => {
  const { apiRoot } = ctx;
  const authorizedRequest = await authorizeRequest(ctx, withRoot(apiRoot, req));
  return withTimestamp(authorizedRequest);
};

const request = async (ctx, req) => {
  const { performRequest } = ctx;
  return performRequest(await prepareRequest(ctx, req));
};

const requestJSON = async (ctx, req) => {
  const headers = {
    "Content-Type": "application/json"
  };
  const parser = responseParser({ format: "json" });
  return request(ctx, withDefaultHeaders(headers, req)).then(parser);
};

const requestText = async (ctx, req) => {
  const headers = {
    "Content-Type": "text/plain"
  };
  const parser = responseParser({ format: "text" });
  return request(ctx, withDefaultHeaders(headers, req)).then(parser);
};

const requestBlob = async (ctx, req) =>
  request(ctx, req).then(responseParser({ format: "blob" }));

const getAuthComponent = () => AuthenticationPage;

const WRITE_ACCESS = 30;
const checkCredentials = async (ctx, credentials) => {
  const { repoURL } = ctx;
  const getCredentials = async () => credentials;
  const newCtx = { ...ctx, getCredentials };

  const results = await Promise.all([
    requestJSON(newCtx, repoURL),
    requestJSON(newCtx, "/user")
  ]);

  const [{ permissions }] = results;

  const { project_access, group_access } = permissions;
  if (project_access && project_access.access_level >= WRITE_ACCESS) {
    return credentials;
  }
  if (group_access && group_access.access_level >= WRITE_ACCESS) {
    return credentials;
  }

  throw new Error("Invalid credentials");
};

const getCursorFromHeaders = headers => {
  const { fromURL: getReqFromURL } = unsentRequest;
  // indices and page counts are assumed to be zero-based, but the
  // indices and page counts returned from GitLab are one-based
  const index = parseInt(headers.get("X-Page"), 10) - 1;
  const pageCount = parseInt(headers.get("X-Total-Pages"), 10) - 1;
  const pageSize = parseInt(headers.get("X-Per-Page"), 10);
  const count = parseInt(headers.get("X-Total"), 10);
  const linksRaw = headers.get("Link");
  const links = List(linksRaw.split(","))
    .map(str => str.trim().split(";"))
    .map(([linkStr, keyStr]) => [
      keyStr.match(/rel="(.*?)"/)[1],
      getReqFromURL(linkStr.trim().match(/<(.*?)>/)[1])
    ])
    .update(list => Map(list));
  const actions = links
    .keySeq()
    .flatMap(
      key =>
        (key === "prev" && index > 0) ||
        (key === "next" && index < pageCount) ||
        (key === "first" && index > 0) ||
        (key === "last" && index < pageCount)
          ? [key]
          : []
    );
  return Cursor.create({
    actions,
    meta: { index, count, pageSize, pageCount },
    data: { links }
  });
};

const getCursorFromResponse = ({ headers }) => getCursorFromHeaders(headers);

const fetchCursor = async (ctx, req) =>
  request(ctx, withMethod("HEAD", req)).then(getCursorFromResponse);

const fetchRelativeCursor = (ctx, cursor, action) =>
  fetchCursor(ctx, cursor.data.links[action]);

const fetchCursorAndEntries = async (ctx, req) => {
  const resp = await request(ctx, withMethod("GET", req));
  return {
    cursor: getCursorFromResponse(resp),
    entries: await responseParser({ format: "json" })(resp)
  };
};

const reversableActions = Map({
  first: "last",
  last: "first",
  next: "prev",
  prev: "next"
});

const reverseCursor = cursor => {
  const pageCount = cursor.meta.get("pageCount", 0);
  const currentIndex = cursor.meta.get("index", 0);
  const newIndex = pageCount - currentIndex;

  const links = cursor.data.get("links", Map());
  const reversedLinks = links.mapEntries(([k, v]) => [
    reversableActions.get(k) || k,
    v
  ]);

  const reversedActions = cursor.actions.map(
    action => reversableActions.get(action) || action
  );

  return cursor.updateStore(store =>
    store
      .setIn(["meta", "index"], newIndex)
      .setIn(["data", "links"], reversedLinks)
      .set("actions", reversedActions)
  );
};

const filterToFileObjects = entries =>
  entries.filter(({ type }) => type === "blob");
const filterCollectionEntries = (collection, entries) => {
  // TODO refactor formatting
  const extension = collection.get("extension", "md");
  return entries.filter(({ name }) => name.endsWith(`.${extension}`));
};

const listFolder = async (ctx, path) => {
  const { branch, repoURL } = ctx;
  const firstPageCursor = await fetchCursor(ctx, {
    url: `${repoURL}/repository/tree`,
    params: { path, ref: branch }
  });
  const lastPageLink = firstPageCursor.data.getIn(["links", "last"]);
  const { entries, cursor } = await fetchCursorAndEntries(ctx, lastPageLink);
  return {
    entries: filterToFileObjects(entries).reverse(),
    cursor: reverseCursor(cursor)
  };
};

const listFullFolder = async (ctx, path) => {
  const { branch, repoURL } = ctx;
  const entries = [];
  const resp = await fetchCursorAndEntries(ctx, {
    url: `${repoURL}/repository/tree`,
    // Get the maximum number of entries per page
    params: { path, ref: branch, per_page: 100 }
  });
  let { cursor } = resp;
  const { entries: initialEntries } = resp;
  while (cursor && cursor.actions.has("next")) {
    const link = cursor.data.getIn(["links", "next"]);
    const {
      cursor: newCursor,
      entries: newEntries
    } = await fetchCursorAndEntries(ctx, link);
    entries.push(...newEntries);
    cursor = newCursor;
  }
  return filterToFileObjects(entries);
};

const toBase64 = str => Promise.resolve(Base64.encode(str));
const fromBase64 = str => Base64.decode(str);
const uploadAndCommit = async (
  ctx,
  item,
  { commitMessage, updateFile = false, branch: optionsBranch, author } = {}
) => {
  const branch = optionsBranch || ctx.branch;
  const content = await (item.toBase64 ? item.toBase64() : toBase64(item.raw));
  // const content = await result(item, "toBase64", partial(toBase64, item.raw));
  const file_path = item.path.replace(/^\//, "");
  const action = updateFile ? "update" : "create";
  const encoding = "base64";

  const commitParams = {
    branch,
    commit_message: commitMessage,
    actions: [{ action, file_path, content, encoding }]
  };
  if (author) {
    const { name, email } = author || ctx.commitAuthor;
    commitParams.author_name = name;
    commitParams.author_email = email;
  }

  await request(ctx, {
    url: `${ctx.repoURL}/repository/commits`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(commitParams)
  });

  return { ...item, uploaded: true };
};

const persistFiles = (ctx, files, { commitMessage, newEntry }) =>
  Promise.all(
    files.map(file =>
      uploadAndCommit(ctx, file, {
        commitMessage,
        updateFile: newEntry === false
      })
    )
  );

const deleteFile = (ctx, path, commitMessage, options = {}) => {
  const { branch: ctxBranch, commitAuthor, repoURL } = ctx;
  const branch = options.branch || ctxBranch;
  const commitParams = { commit_message: commitMessage, branch };
  if (commitAuthor) {
    commitParams.author_name = name;
    commitParams.author_email = email;
  }
  const reqWithMethod = withMethod("DELETE", req);
  const reqWithParams = withParams(commitParams, reqWithMethod);
  return request(
    ctx,
    `${repoURL}/repository/files/${encodeURIComponent(path)}`
  );
};

const readFile = async (
  ctx,
  path,
  { id, ref: refArg, parseText = true } = {}
) => {
  const { branch, getCacheItem, setCacheItem } = ctx;
  const ref = refArg || branch;
  const cachedFile = id && (await getCacheItem(id));
  if (cachedFile) {
    return cachedFile;
  }
  if (!ref || ref === "") {
    debugger;
  }
  const result = await (parseText ? requestText : requestBlob)(ctx, {
    url: `${ctx.repoURL}/repository/files/${encodeURIComponent(path)}/raw`,
    params: { ref },
    cache: "no-store"
  });
  if (id) {
    setCacheItem(id, result);
  }
  return result;
};

const getEntry = async (ctx, collection, path) => ({
  file: { path },
  data: await readFile(ctx, path)
});

const fetchFiles = async (ctx, files) => {
  const filePromises = files.map(async file => {
    try {
      const { path, id } = file;
      const data = await readFile(ctx, path, { id });
      return { file, data };
    } catch (error) {
      console.error(`failed to load file from GitLab: ${file.path}`);
      return error;
    }
  });
  const loadedFiles = await Promise.all(filePromises);
  return loadedFiles.filter(item => !isError(item));
};

const getFolderCollectionEntries = async (ctx, collection) => {
  const folder = collection.get("folder");
  const { entries, cursor } = await listFolder(ctx, folder);
  const filteredFiles = filterCollectionEntries(collection, entries);
  const fetchedFiles = await fetchFiles(ctx, filteredFiles);
  return { entries: fetchedFiles, cursor };
};

const getAllFolderCollectionEntries = async (ctx, collection) => {
  const folder = collection.get("folder");
  const files = await listFullFolder(ctx, folder);
  const filteredFiles = filterCollectionEntries(collection, files);
  return { entries: await fetchFiles(ctx, filteredFiles) };
};

const getFilesCollectionEntries = async (ctx, collection) => {
  const files = collection.get("files").map(collectionFile => ({
    path: collectionFile.get("file"),
    label: collectionFile.get("label")
  }));
  const fetchedFiles = await fetchFiles(ctx, files);
  return { entries: fetchedFiles };
};

const getCollectionEntries = (ctx, collection) =>
  (collection.get("folder")
    ? getFolderCollectionEntries
    : getFilesCollectionEntries)(ctx, collection);

const getAllCollectionEntries = (ctx, collection, id) =>
  (collection.get("folder")
    ? getAllFolderCollectionEntries
    : getFilesCollectionEntries)(ctx, collection);

const getMediaFile = (ctx, { id, name, path }) => {
  const getBlobPromise = () => readFile(ctx, path, { id, parseText: false })
  return { id, name, getBlobPromise, path };
};

const getMedia = ctx => {
  const { config } = ctx;
  const mediaFolder = config.get("media_folder");
  return listFullFolder(ctx, mediaFolder).then(
    map(file => getMediaFile(ctx, file))
  );
};

const traverseCursor = async (ctx, cursor, action) => {
  const link = cursor.data.getIn(["links", action]);
  const { entries, cursor: newCursor } = await fetchCursorAndEntries(ctx, link);
  const loadedEntries = await Promise.all(
    entries
      .reverse()
      .map(file =>
        readFile(ctx, file.path, { id: file.id }).then(data => ({ file, data }))
      )
  );
  return { entries: loadedEntries, cursor: reverseCursor(newCursor) };
};

const persistEntry = (ctx, entry, options = {}) =>
  persistFiles(ctx, [entry], options);

const persistMedia = async (ctx, mediaFile, options = {}) => {
  await persistFiles([mediaFile], options);
  const { value, path, fileObj } = mediaFile;
  const getBlobPromise = () => Promise.resolve(fileObj);
  return {
    name: value,
    size: fileObj.size,
    getBlobPromise,
    path: trimStart(path, "/")
  };
};

const API = {
  name: "gitlab",
  checkCredentials,
  getContext,
  getAuthComponent,
  getCollectionEntries,
  getAllCollectionEntries,
  getEntry,
  getMedia,
  persistEntry,
  persistMedia,
  deleteFile,
  traverseCursor
};

export const GitLabBackend = getWrapperClassForNewAPI(API);
