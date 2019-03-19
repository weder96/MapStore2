/*
 * Copyright 2018, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
*/

const Rx = require('rxjs');
const uuidv1 = require('uuid/v1');
const assign = require('object-assign');
const ConfigUtils = require('../utils/ConfigUtils');
const {basicError, basicSuccess} = require('../utils/NotificationUtils');
const GeoStoreApi = require('../api/GeoStoreDAO');
const { MAP_INFO_LOADED } = require('../actions/config');
const {isNil, find, difference} = require('lodash');
const {
    SAVE_DETAILS, SAVE_RESOURCE_DETAILS, MAPS_GET_MAP_RESOURCES_BY_CATEGORY,
    DELETE_MAP, OPEN_DETAILS_PANEL, MAPS_LOAD_MAP,
    CLOSE_DETAILS_PANEL, NO_DETAILS_AVAILABLE, SAVE_MAP_RESOURCE,
    setDetailsChanged, updateDetails, mapsLoading, mapsLoaded,
    mapDeleting, toggleDetailsEditability, mapDeleted, loadError,
    doNothing, detailsLoaded, detailsSaving, onDisplayMetadataEdit,
    RESET_UPDATING, resetUpdating, toggleDetailsSheet, getMapResourcesByCategory,
    mapUpdating, savingMap, mapCreated, mapError, BACKGROUND_THUMBNAIL_CREATED,
    saveMapResource, thumbnailError
} = require('../actions/maps');
const {
    resetCurrentMap, EDIT_MAP
} = require('../actions/currentMap');
const {closeFeatureGrid} = require('../actions/featuregrid');
const {toggleControl} = require('../actions/controls');
const {updateNode} = require('../actions/layers');
const {updateThumbnail, backgroundThumbnailsUpdated, clearModalParameters, BACKGROUND_THUMBS_UPDATED, clearBackgrounds} = require('../actions/backgroundselector');
const {
    mapPermissionsFromIdSelector, mapThumbnailsUriFromIdSelector,
    mapDetailsUriFromIdSelector
} = require('../selectors/maps');
const {backgroundsSourceListSelector} = require('../selectors/backgroundselector');
const {mapOptionsToSaveSelector} = require('../selectors/mapsave');
const {
    mapIdSelector, mapInfoDetailsUriFromIdSelector, mapSelector
} = require('../selectors/map');
const {
    currentMapDetailsTextSelector, currentMapIdSelector,
    currentMapDetailsUriSelector, currentMapSelector,
    currentMapDetailsChangedSelector, currentMapOriginalDetailsTextSelector
} = require('../selectors/currentmap');
const {layersSelector, groupsSelector, allBackgroundLayerSelector} = require('../selectors/layers');
const {userParamsSelector} = require('../selectors/security');
const {deleteResourceById, createAssociatedResource, deleteAssociatedResource, updateAssociatedResource} = require('../utils/ObservableUtils');

const {getIdFromUri, saveMapConfiguration} = require('../utils/MapUtils');

const {getErrorMessage} = require('../utils/LocaleUtils');
const Persistence = require("../api/persistence");
const uuid = require('uuid/v1');

const manageMapResource = ({map = {}, attribute = "", resource = null, type = "STRING", optionsDel = {}, messages = {}} = {}) => {
    const attrVal = map[attribute];
    const mapId = map.id;
    // create
    if ((isNil(attrVal) || attrVal === "NODATA") && !isNil(resource)) {
        return createAssociatedResource({...resource, attribute, mapId, type, messages});
    }
    if (isNil(resource)) {
        // delete
        return deleteAssociatedResource({
            mapId,
            attribute,
            type,
            resourceId: getIdFromUri(attrVal),
            options: optionsDel,
            messages});
    }
    // update
    return updateAssociatedResource({
        permissions: resource.permissions,
        resourceId: getIdFromUri(attrVal),
        value: resource.value,
        attribute,
        options: resource.optionsAttr,
        messages});

};

/**
    If details are changed from the original ones then set unsavedChanges to true
*/
const setDetailsChangedEpic = (action$, store) =>
    action$.ofType(SAVE_DETAILS)
    .switchMap((a) => {
        let actions = [];
        const state = store.getState();
        const detailsUri = currentMapDetailsUriSelector(state);
        if (a.detailsText.length <= 500000) {
            actions.push(toggleDetailsSheet(true));
        } else {
            actions.push(basicError({message: "maps.feedback.errorSizeExceeded"}));
        }
        if (!detailsUri) {
            actions.push(setDetailsChanged(a.detailsText !== "<p><br></p>"));
            return Rx.Observable.from(actions);
        }
        const originalDetails = currentMapOriginalDetailsTextSelector(state);
        const currentDetails = currentMapDetailsTextSelector(state);
        actions.push(setDetailsChanged(originalDetails !== currentDetails));
        return Rx.Observable.from(actions);
    });


/**
 * If the details resource does not exist it saves it, and it updates its permission with the one set for the mapPermissionsFromIdSelector
 * and it updates the attribute details in map resource
*/
const saveResourceDetailsEpic = (action$, store) =>
    action$.ofType(SAVE_RESOURCE_DETAILS)
    .switchMap(() => {
        const state = store.getState();
        const mapId = currentMapIdSelector(state);
        const value = currentMapDetailsTextSelector(state, mapId);
        const detailsChanged = currentMapDetailsChangedSelector(state);

        let params = {
            attribute: "details",
            map: currentMapSelector(state),
            resource: null,
            type: "STRING"
        };
        if (!detailsChanged) {
            return Rx.Observable.of(doNothing());
        }
        if (value !== "" && detailsChanged) {
            params.resource = {
                category: "DETAILS",
                userParams: userParamsSelector(state),
                metadata: {name: uuidv1()},
                value,
                permissions: mapPermissionsFromIdSelector(state, mapId),
                optionsAttr: {},
                optionsRes: {}
            };
        } else {
            params.optionsDel = {};
        }
        return manageMapResource({
            ...params
        }).concat([detailsSaving(false), resetUpdating(mapId)]).startWith(detailsSaving(true));
    });

/**
    Epics used to fetch and/or open the details modal
*/
const fetchDetailsFromResourceEpic = (action$, store) =>
    action$.ofType(EDIT_MAP)
    .switchMap(() => {
        const state = store.getState();
        const mapId = currentMapIdSelector(state);
        const detailsUri = currentMapDetailsUriSelector(state);
        if (!detailsUri || detailsUri === "NODATA") {
            return Rx.Observable.of(
                updateDetails("", true, "")
            );
        }
        const detailsId = getIdFromUri(detailsUri);
        return Rx.Observable.fromPromise(GeoStoreApi.getData(detailsId)
            .then(data => data))
            .switchMap((details) => {
                return Rx.Observable.of(
                    updateDetails(details, true, details)
                );
            }).catch(() => {
                return Rx.Observable.of(
                    basicError({ message: "maps.feedback.errorFetchingDetailsOfMap"}),
                    updateDetails(NO_DETAILS_AVAILABLE, true, NO_DETAILS_AVAILABLE),
                    toggleDetailsEditability(mapId));
            });
    });

    /**
         Epics used to load Maps
     */
const loadMapsEpic = (action$) =>
    action$.ofType(MAPS_LOAD_MAP)
    .switchMap((action) => {
        let {params, searchText, geoStoreUrl} = action;
        let modifiedSearchText = searchText.replace(/[/?:;@=&\\]+/g, '');
        let opts = assign({}, {params}, geoStoreUrl ? {baseURL: geoStoreUrl} : {});
        return Rx.Observable.of(
            mapsLoading(modifiedSearchText, params),
            getMapResourcesByCategory("MAP", modifiedSearchText, opts)
        );

    });

const getMapsResourcesByCategoryEpic = (action$) =>
    action$.ofType(MAPS_GET_MAP_RESOURCES_BY_CATEGORY)
    .switchMap((action) => {
        let {map, searchText, opts } = action;
        return Rx.Observable.fromPromise(GeoStoreApi.getResourcesByCategory(map, searchText, opts)
    .then(data => data))
    .switchMap((response) => Rx.Observable.of(
        mapsLoaded(response, opts.params, searchText)
    ))
    .catch((e) => loadError(e));
    });
const deleteMapAndAssociatedResourcesEpic = (action$, store) =>
    action$.ofType(DELETE_MAP)
    .switchMap((action) => {
        const state = store.getState();
        const mapId = action.resourceId;
        const options = action.options;
        const detailsUri = mapDetailsUriFromIdSelector(state, mapId);
        const thumbnailUri = mapThumbnailsUriFromIdSelector(state, mapId);
        const detailsId = getIdFromUri(detailsUri);
        const thumbnailsId = getIdFromUri(thumbnailUri);

        return Rx.Observable.forkJoin(
            // delete details
            deleteResourceById(thumbnailsId, options),
            // delete thumbnail
            deleteResourceById(detailsId, options),
            // delete map
            deleteResourceById(mapId, options)
        ).concatMap(([details, thumbnail, map]) => {
            let actions = [];
            if (details.resType === "error") {
                actions.push(basicError({message: "maps.feedback.errorDeletingDetailsOfMap"}));
            }
            if (thumbnail.resType === "error") {
                actions.push(basicError({message: "maps.feedback.errorDeletingThumbnailOfMap"}));
            }
            if (map.resType === "error") {
                actions.push(basicError({message: "maps.feedback.errorDeletingMap"}));
                actions.push(mapDeleted(mapId, "failure", map.error));
            }
            if (map.resType === "success") {
                actions.push(mapDeleted(mapId, "success"));
                // TODO: if after delete the page is empty, you should re-do the query for the previous page (if it exists)
                // something like :
                // if ( condition ) {
                //    actions.push(loadMaps(false, state.maps.searchText || ConfigUtils.getDefaults().initialMapFilter || "*")); // first page
                // }
            }
            if (map.resType === "success" && details.resType === "success" && thumbnail.resType === "success") {
                actions.push(basicSuccess({ message: "maps.feedback.allResDeleted"}));

            }
            return Rx.Observable.from(actions);
        }).startWith(mapDeleting(mapId));
    });

const fetchDataForDetailsPanel = (action$, store) =>
    action$.ofType(OPEN_DETAILS_PANEL)
    .switchMap(() => {
        const state = store.getState();
        const detailsUri = mapInfoDetailsUriFromIdSelector(state);
        const detailsId = getIdFromUri(detailsUri);
        return Rx.Observable.fromPromise(GeoStoreApi.getData(detailsId)
            .then(data => data))
            .switchMap((details) => {
                return Rx.Observable.from( [
                        closeFeatureGrid(),
                        updateDetails(details, true, details
                    )]
                );
            }).startWith(toggleControl("details", "enabled"))
            .catch(() => {
                return Rx.Observable.of(
                    basicError({message: "maps.feedback.errorFetchingDetailsOfMap"}),
                    updateDetails(NO_DETAILS_AVAILABLE, true, NO_DETAILS_AVAILABLE)
                );
            });
    });

const closeDetailsPanelEpic = (action$) =>
    action$.ofType(CLOSE_DETAILS_PANEL)
    .switchMap(() => Rx.Observable.from( [
                toggleControl("details", "enabled"),
                resetCurrentMap()
            ])
    );
const resetCurrentMapEpic = (action$) =>
    action$.ofType(RESET_UPDATING)
    .switchMap(() => Rx.Observable.from( [
                onDisplayMetadataEdit(false),
                resetCurrentMap()
            ])
    );
const storeDetailsInfoEpic = (action$, store) =>
    action$.ofType(MAP_INFO_LOADED)
    .switchMap(() => {
        const mapId = mapIdSelector(store.getState());
        return !mapId ?
            Rx.Observable.empty() :
            Rx.Observable.fromPromise(
                GeoStoreApi.getResourceAttributes(mapId)
            )
            .switchMap((attributes) => {
                let details = find(attributes, {name: 'details'});
                if (!details) {
                    return Rx.Observable.empty();
                }
                return Rx.Observable.of(
                        detailsLoaded(mapId, details.value)
                    );
            });
    });
// UPDATE MAP_RESOURCE FLOW
const updateMapResource = (resource) => Persistence.updateResource(resource)
        .switchMap(() =>
            Rx.Observable.of(basicSuccess({
                    title: 'map.savedMapTitle',
                    message: 'map.savedMapMessage',
                    autoDismiss: 6,
                    position: 'tc'
                        })
            )
        )
        .catch((e) => Rx.Observable.of(loadError(e), basicError({
            ...getErrorMessage(e, 'geostore', 'mapsError'),
            autoDismiss: 6,
            position: 'tc'
        })
        ))
        .startWith(mapUpdating(resource.metadata));
// CREATE MAP_RESOURCE FLOW
const createMapResource = (resource) => Persistence.createResource(resource)
        .switchMap((rid) =>
            Rx.Observable.of(
                mapCreated(rid, assign({id: rid, canDelete: true, canEdit: true, canCopy: true}, resource.metadata), resource.data),
                onDisplayMetadataEdit(false),
                basicSuccess({
                    title: 'map.savedMapTitle',
                    message: 'map.savedMapMessage',
                    autoDismiss: 6,
                    position: 'tc'
                })
                )
        )
        .catch((e) => Rx.Observable.of(mapError(e), basicError({
                ...getErrorMessage(e, 'geostore', 'mapsError'),
                autoDismiss: 6,
                position: 'tc'
            })
        ))
        .startWith(savingMap(resource.metadata));
/**
 * Create or update map resource with persistence api
 */
const mapSaveMapResourceEpic = (action$) =>
      action$.ofType(SAVE_MAP_RESOURCE)
      .exhaustMap(({resource}) => (!resource.id ? createMapResource(resource) : updateMapResource(resource))
    );


const updateMap = (response, backgroundID) => {
    const thumbnailUrl = ConfigUtils.getDefaults().geoStoreUrl + "data/" + response + "/raw?decode=datauri";
    // add encodedThumbnailUrl and id to the background thumbnail source
    return Rx.Observable.of(
        updateNode(backgroundID, "layers", { source: thumbnailUrl, thumbId: response }),
        updateThumbnail(null, null, false, backgroundID));
};
const createBackgroundThumbnail = (nameThumbnail, dataThumbnail, categoryThumbnail, backgroundID, properties) => {
    let metadata = {
        name: nameThumbnail
    };

    if (nameThumbnail && dataThumbnail) {
        return Persistence.createResource({metadata: metadata, data: dataThumbnail, category: categoryThumbnail, backgroundID}).map((response) => ({response, backgroundID}));
     } else if (properties.thumbId) {
         // clear the layer data from the related resource
         return Rx.Observable.of(updateNode(backgroundID, "layers", { source: undefined, thumbId: undefined }));
     }
    return Rx.Observable.empty();

};

const mapSaveBackgroundThumbnails = (action$) =>
    action$.ofType(BACKGROUND_THUMBNAIL_CREATED)
    .switchMap((action) => {
        // list of source id's of backgrounds with removed thumbnails
        let removedResources = [];
        action.data.backgrounds.filter((background)=> !background.CurrentNewThumbnail && !background.CurrentThumbnailData && background.thumbId)
        .map(layer => removedResources.push(layer.thumbId));
        return Rx.Observable.forkJoin(
            ...action.data.backgrounds.map(layer =>
                createBackgroundThumbnail(layer.CurrentNewThumbnail, layer.CurrentThumbnailData, "BACKGROUND_THUMBNAIL", layer.id, {source: layer.source, thumbId: layer.thumbId}))
            )
            .switchMap(results => {

                return Rx.Observable.from(results.map( (response) => response.response && response.backgroundID ? updateMap(response.response, response.backgroundID) : Rx.Observable.of(response))).mergeAll();
            })
            .concat(
            Rx.Observable.of(clearBackgrounds(), clearModalParameters(), backgroundThumbnailsUpdated(action.data.thumbName, action.data.metadata, action.data.data, removedResources))
            .catch(e => Rx.Observable.of(thumbnailError(null, e))));
    });


const mapSaveUpdatedBackgroundThumbnails = (action$, store) =>
    action$.ofType(BACKGROUND_THUMBS_UPDATED)
    .switchMap((action) => {
        const state = store.getState();
        const id = mapIdSelector(state);
        const groups = groupsSelector(state);
        const textSearchConfig = (st) => st.searchconfig && st.searchconfig.textSearchConfig;
        const additionalOptions = mapOptionsToSaveSelector(state);
        const initialList = backgroundsSourceListSelector(state);
        const backgrounds = allBackgroundLayerSelector(state);
        let finalList = [];
        backgrounds.filter((background) => background.thumbId !== undefined).map(l => finalList.push(l.thumbId));
        const deletedList = difference(initialList, finalList);
        return Rx.Observable.forkJoin(
            ...deletedList.map(resource => deleteResourceById(resource))
        ).switchMap(results => {

            return Rx.Observable.from(results.map( () => Rx.Observable.empty())).mergeAll();
        })
        .concat(Rx.Observable.of(saveMapResource({id: id, category: "MAP", data: saveMapConfiguration(mapSelector(state), layersSelector(state), groups, textSearchConfig(state), additionalOptions),
        metadata: action.metadata, linkedResources: action.data && {thumbnail: {
            data: action.data,
            category: "THUMBNAIL",
            name: action.mapThumb,
            tail: `/raw?decode=datauri&v=${uuid()}`
            }} || {}}
        )));
    });

module.exports = {
    loadMapsEpic,
    resetCurrentMapEpic,
    storeDetailsInfoEpic,
    closeDetailsPanelEpic,
    fetchDataForDetailsPanel,
    deleteMapAndAssociatedResourcesEpic,
    getMapsResourcesByCategoryEpic,
    setDetailsChangedEpic,
    fetchDetailsFromResourceEpic,
    saveResourceDetailsEpic,
    mapSaveMapResourceEpic,
    mapSaveBackgroundThumbnails,
    mapSaveUpdatedBackgroundThumbnails
};
