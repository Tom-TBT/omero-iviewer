//
// Copyright (C) 2025 University of Dundee & Open Microscopy Environment.
// All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

import Context from '../app/context';
import { IVIEWER, ROI_TABS, WEBCLIENT } from '../utils/constants';
import { REGIONS_SET_PROPERTY } from '../events/events';
import { inject, customElement, bindable, BindingEngine } from 'aurelia-framework';

/**
 * Represents the regions tags sub-tab in the right hand panel.
 *
 * Reorganizes the Rois/Shapes already held by regions_info.data by the Tags
 * (and Tagsets) linked to them, instead of by id. Read-only: navigates and
 * highlights existing ROIs/Shapes, does not create/attach/detach tags.
 */
@customElement('regions-tags')
@inject(Context, BindingEngine)
export default class RegionsTags {
    /**
     * a bound reference to regions_info
     * @memberof RegionsTags
     * @type {RegionsInfo}
     */
    @bindable regions_info = null;

    /**
     * When regions_info is swapped out (e.g. a different image), drop any
     * cached tags/tree and wait for the new regions_info to be ready before
     * fetching/building again.
     * @param {RegionsInfo} newVal
     * @param {RegionsInfo} oldVal
     */
    regions_infoChanged(newVal, oldVal) {
        this.tags_info = null;
        this.tree = null;
        this.rows = [];
        this.waitForRegionsInfoReady();
    }

    /**
     * The current ROI sub-tab selected by the parent regions component
     */
    @bindable selected_roi_tab = null;

    /**
     * When the selected_roi_tab changes, load data (if not already loaded),
     * or just re-flatten the tree in case regions_info.data has since
     * changed (e.g. new shapes drawn) while this tab wasn't visible.
     * @param {String} newVal
     * @param {String} oldVal
     */
    selected_roi_tabChanged(newVal, oldVal) {
        if (this.selected_roi_tab !== ROI_TABS.ROI_TAGS) return;
        if (!this.regions_info || !this.regions_info.ready) return;
        this.registerObservers();
        if (this.tags_info === null) this.requestData();
        else this.buildTree();
    }

    /**
     * Raw response from the image_tags endpoint
     * @type {Object}
     */
    tags_info = null;

    /**
     * The Tagset/Tag/Roi/Shape tree built from tags_info + regions_info.data
     * @type {Object}
     */
    tree = null;

    /**
     * Flattened, visible (i.e. respecting collapse state) rows of the tree,
     * used for a single repeat.for in the template.
     * @type {Array.<Object>}
     */
    rows = [];

    /**
     * Flag to indicate when we are loading data
     * @type {Boolean}
     */
    is_pending = false;

    /**
     * Observer that watches regions_info.ready, since Rois/Shapes for a
     * (new) image finish loading asynchronously, independently of when
     * this tab's own tag data has been fetched.
     * @memberof RegionsTags
     * @type {Object}
     */
    regions_ready_observer = null;

    /**
     * Observers that watch regions_info.selected_shapes/visibility_toggles,
     * so that selection/visibility changes made elsewhere (the viewer, the
     * ROIs tab, or this tab's own toggles) are reflected here too - a Shape
     * or Roi's own selected/visible flag is mutated in place, not via
     * reassignment, so nothing would otherwise tell this tab's rows to
     * re-render (see registerObservers/flatten).
     * @memberof RegionsTags
     * @type {Array.<Object>}
     */
    observers = [];

    /**
     * Which Shape attribute Shape lists (within a Roi, or directly under a
     * Tag) are ordered by - one of 'theC', 'theT', 'shapeText', or null for
     * the natural (Z/T import) order. Applies wherever a list of Shapes is
     * rendered, i.e. "within tags".
     * @type {String}
     */
    sortBy = null;

    /**
     * @type {Boolean}
     */
    sortAscending = true;

    /**
     * @constructor
     * @param {Context} context the application context (injected)
     * @param {BindingEngine} bindingEngine the BindingEngine (injected)
     */
    constructor(context, bindingEngine) {
        this.context = context;
        this.bindingEngine = bindingEngine;
    }

    /**
     * Overridden aurelia lifecycle method:
     * called whenever the view is bound within aurelia
     *
     * @memberof RegionsTags
     */
    bind() {
        this.waitForRegionsInfoReady();
    }

    /**
     * Overridden aurelia lifecycle method:
     * called when the view is unbound within aurelia
     *
     * @memberof RegionsTags
     */
    unbind() {
        this.unregisterObservers();
        if (this.regions_ready_observer) {
            this.regions_ready_observer.dispose();
            this.regions_ready_observer = null;
        }
    }

    /**
     * Registers the selected_shapes/visibility_toggles observers (once -
     * a no-op if already registered for the current regions_info).
     *
     * @memberof RegionsTags
     */
    registerObservers() {
        if (this.observers.length > 0 || this.regions_info === null) return;
        // deferred: flatten() reassigns this.rows, which makes the
        // repeat.for tear down/rebuild every row's DOM. Publishing a
        // visibility/selection change from one of our own checkboxes ends
        // up back here *synchronously*, while that same checkbox is still
        // mid-"change" event - rebuilding its element out from under it
        // right then stops the browser from ever showing the new state.
        // Doing it on the next tick lets the originating event finish first.
        const deferredFlatten = () => setTimeout(() => this.flatten(), 0);
        this.observers.push(
            this.bindingEngine.collectionObserver(
                this.regions_info.selected_shapes).subscribe(deferredFlatten));
        this.observers.push(
            this.bindingEngine.propertyObserver(
                this.regions_info, 'visibility_toggles')
                .subscribe(deferredFlatten));
    }

    /**
     * Disposes the selected_shapes/visibility_toggles observers.
     *
     * @memberof RegionsTags
     */
    unregisterObservers() {
        this.observers.forEach((o) => { if (o) o.dispose(); });
        this.observers = [];
    }

    /**
     * Makes sure we (re)fetch/(re)build once regions_info.data is actually
     * ready, whether that's already the case or happens shortly after
     * (e.g. following an image switch).
     *
     * @memberof RegionsTags
     */
    waitForRegionsInfoReady() {
        this.unregisterObservers();
        if (this.regions_ready_observer) {
            this.regions_ready_observer.dispose();
            this.regions_ready_observer = null;
        }
        if (this.regions_info === null) return;

        const onceReady = () => {
            this.registerObservers();
            if (this.selected_roi_tab !== ROI_TABS.ROI_TAGS) return;
            if (this.tags_info === null) this.requestData(true);
            else this.buildTree();
        };

        if (this.regions_info.ready) {
            onceReady();
            return;
        }
        this.regions_ready_observer =
            this.bindingEngine.propertyObserver(
                this.regions_info, 'ready').subscribe(
                    (newValue) => { if (newValue) onceReady(); });
    }

    /**
     * Loads the tags/tagsets linked to the ROIs/Shapes of the current image
     * @param {Boolean} refresh if true we reload even if already loaded
     */
    requestData(refresh = false) {
        if (this.tags_info !== null && !refresh) return;
        this.is_pending = true;

        $.ajax({
            url:
                this.context.server + this.context.getPrefixedURI(IVIEWER) +
                '/image_tags/' + this.regions_info.image_info.image_id + '/',
            success: (response) => {
                this.is_pending = false;
                this.tags_info = response;
                this.buildTree();
            },
            error: (error) => {
                this.is_pending = false;
                console.error("Failed to load tags: " + error);
            }
        });
    }

    /**
     * Icon url for the Tagset/Tag icons (served by omero.web, not this app)
     * @param {String} which one of 'tags' (tagset icon) or 'tag'
     */
    getIconUrl(which) {
        return this.context.server +
            this.context.getPrefixedURI(WEBCLIENT, true) +
            '/image/left_sidebar_icon_' + which + '.png';
    }

    /**
     * Builds the Tagset > Tag > Roi > Shape tree from tags_info (the flat
     * roi_tags/shape_tags/tags/tagsets response) and regions_info.data (the
     * live Roi/Shape objects, reused by reference so selection/visibility
     * stay in sync with the ROIs tab and viewer for free).
     */
    buildTree() {
        if (this.tags_info === null || this.regions_info === null) return;
        const data = this.regions_info.data;
        const tags = this.tags_info.tags;
        const tagsets = this.tags_info.tagsets;

        // group the flat link lists by tag id
        const roiIdsByTag = new Map();
        this.tags_info.roi_tags.forEach(([roi_id, tag_id]) => {
            if (!roiIdsByTag.has(tag_id)) roiIdsByTag.set(tag_id, new Set());
            roiIdsByTag.get(tag_id).add(roi_id);
        });
        const shapesByTag = new Map();
        this.tags_info.shape_tags.forEach(([roi_id, shape_id, tag_id]) => {
            if (!shapesByTag.has(tag_id)) shapesByTag.set(tag_id, []);
            shapesByTag.get(tag_id).push({ roi_id, shape_id });
        });

        const makeRoiNode = (roi_id) => {
            const roi = data instanceof Map ? data.get(roi_id) : undefined;
            return { roi_id, roi: roi || null, missing: !roi, show: false };
        };
        const makeShapeRef = (roi_id, shape_id) => {
            const roi = data instanceof Map ? data.get(roi_id) : undefined;
            const shape = (roi && roi.shapes instanceof Map) ?
                roi.shapes.get(shape_id) : undefined;
            return {
                roi_id, shape_id, shape: shape || null, missing: !shape
            };
        };
        const makeTagNode = (tag_id) => {
            const tag = tags[tag_id] || { id: tag_id, text: '#' + tag_id };
            const roiIds = roiIdsByTag.get(tag_id) || new Set();
            const rois = Array.from(roiIds).map(makeRoiNode);
            const shapeEntries = shapesByTag.get(tag_id) || [];
            // a Shape is only shown flat under the tag if its own Roi isn't
            // already tagged with this same tag (avoids duplicate display)
            const shapes = shapeEntries
                .filter((e) => !roiIds.has(e.roi_id))
                .map((e) => makeShapeRef(e.roi_id, e.shape_id));
            return { id: tag_id, text: tag.text, show: true, rois, shapes };
        };

        // every tag id that is actually linked to something on this image
        const linkedTagIds =
            new Set([...roiIdsByTag.keys(), ...shapesByTag.keys()]);

        // one node per tagset (in server order), only kept if non-empty
        const tagsetNodesById = new Map();
        Object.keys(tagsets).forEach((key) => {
            const tagset = tagsets[key];
            tagsetNodesById.set(
                tagset.id,
                { id: tagset.id, text: tagset.text, show: true, tags: [] });
        });

        const orphanTags = [];
        linkedTagIds.forEach((tag_id) => {
            const tag = tags[tag_id];
            const tagNode = makeTagNode(tag_id);
            const tagsetNode = tag && tag.tagset_id !== null ?
                tagsetNodesById.get(tag.tagset_id) : undefined;
            if (tagsetNode) tagsetNode.tags.push(tagNode);
            else orphanTags.push(tagNode);
        });

        const tagsets_ordered = [];
        Object.keys(tagsets).forEach((key) => {
            const node = tagsetNodesById.get(tagsets[key].id);
            if (node.tags.length > 0) tagsets_ordered.push(node);
        });

        // Rois with zero tag links at all (neither the Roi itself, nor any
        // of its Shapes) - shown last, same as a normal Roi entry.
        const taggedRoiIds = new Set();
        roiIdsByTag.forEach((set) => set.forEach((id) => taggedRoiIds.add(id)));
        shapesByTag.forEach(
            (list) => list.forEach((e) => taggedRoiIds.add(e.roi_id)));

        const orphanRois = [];
        if (data instanceof Map) {
            data.forEach((roi, roi_id) => {
                if (!taggedRoiIds.has(roi_id)) {
                    orphanRois.push(
                        { roi_id, roi, missing: false, show: false });
                }
            });
        }

        this.tree = {
            tagsets: tagsets_ordered, orphanTags, orphanRois
        };
        this.flatten();
    }

    /**
     * Adds the rows for a Tag node (and, if expanded, its Roi/Shape
     * children) to the given rows array.
     * @param {Array.<Object>} rows
     * @param {Object} tag
     * @param {Number} depth
     */
    addTagRows(rows, tag, depth) {
        rows.push({ type: 'tag', depth, key: 'tag-' + tag.id, node: tag });
        if (!tag.show) return;
        tag.rois.forEach((roiNode) => {
            const roiKey = 'tagroi-' + tag.id + '-' + roiNode.roi_id;
            rows.push({
                type: 'roi', depth: depth + 1, key: roiKey, node: roiNode
            });
            if (roiNode.show && roiNode.roi &&
                roiNode.roi.shapes instanceof Map) {
                const shapes = this.sortShapeRefs(
                    Array.from(roiNode.roi.shapes.values()), (s) => s);
                shapes.forEach((shape) => {
                    const shape_id = shape['@id'];
                    rows.push({
                        type: 'shape', depth: depth + 2,
                        key: roiKey + '-shape-' + shape_id,
                        node: { shape, roi_id: roiNode.roi_id, shape_id }
                    });
                });
            }
        });
        this.sortShapeRefs(tag.shapes, (e) => e.shape).forEach((shapeRef) => {
            rows.push({
                type: 'shape', depth: depth + 1,
                key: 'tagshape-' + tag.id + '-' + shapeRef.shape_id,
                node: shapeRef
            });
        });
    }

    /**
     * Adds the rows for an (orphan) Roi node (and, if expanded, its Shapes)
     * to the given rows array.
     * @param {Array.<Object>} rows
     * @param {Object} roiNode
     * @param {Number} depth
     */
    addRoiRows(rows, roiNode, depth) {
        const roiKey = 'orphanroi-' + roiNode.roi_id;
        rows.push({ type: 'roi', depth, key: roiKey, node: roiNode });
        if (roiNode.show && roiNode.roi &&
            roiNode.roi.shapes instanceof Map) {
            const shapes = this.sortShapeRefs(
                Array.from(roiNode.roi.shapes.values()), (s) => s);
            shapes.forEach((shape) => {
                const shape_id = shape['@id'];
                rows.push({
                    type: 'shape', depth: depth + 1,
                    key: roiKey + '-shape-' + shape_id,
                    node: { shape, roi_id: roiNode.roi_id, shape_id }
                });
            });
        }
    }

    /**
     * Sorting value for a Shape for the currently active sortBy attribute.
     * Mirrors the getNumberAttr/getShapeText helpers in sort.js: -1 (the
     * "applies to all planes" placeholder) sorts last, like a missing value.
     *
     * @param {Object} shape a (live) Shape object
     * @return {String|Number|undefined}
     */
    shapeSortValue(shape) {
        if (!shape) return undefined;
        if (this.sortBy === 'shapeText') return (shape.Text || '').toLowerCase();
        const attr = this.sortBy === 'theC' ? 'TheC' : 'TheT';
        const value = shape[attr];
        return value === -1 ? undefined : value;
    }

    /**
     * Sorts a list of entries by the currently active sortBy/sortAscending,
     * without mutating the input (in particular, never reorders the Shapes
     * Map shared with regions_info.data / the ROIs tab).
     *
     * @param {Array.<Object>} entries Shape objects, or wrapper objects
     * @param {Function} getShape (entry) => the Shape object to sort by
     * @return {Array.<Object>} a new, sorted array
     */
    sortShapeRefs(entries, getShape) {
        if (!this.sortBy) return entries;
        const sorted = entries.slice().sort((a, b) => {
            const av = this.shapeSortValue(getShape(a));
            const bv = this.shapeSortValue(getShape(b));
            if (av === undefined && bv === undefined) return 0;
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            if (av > bv) return 1;
            if (av < bv) return -1;
            return 0;
        });
        return this.sortAscending ? sorted : sorted.reverse();
    }

    /**
     * Sets/toggles the Shape sort attribute (see sortBy) and re-flattens.
     * @param {String} value one of 'theC', 'theT', 'shapeText'
     */
    sort(value) {
        this.sortAscending = this.sortBy === value ? !this.sortAscending : true;
        this.sortBy = value;
        this.flatten();
    }

    /**
     * CSS class for a sortable column header, matching regions-list.html's
     * sortable/asc/desc arrow convention.
     * @param {String} attrName one of 'theC', 'theT', 'shapeText'
     */
    sortCss(attrName) {
        if (attrName !== this.sortBy) return 'sortable';
        return this.sortAscending ? 'sortable asc' : 'sortable desc';
    }

    /**
     * Recomputes this.rows (the visible, flattened rows) from this.tree,
     * honoring each node's show/collapsed state. Called after building the
     * tree and after any node is expanded/collapsed.
     */
    flatten() {
        if (this.tree === null) {
            this.rows = [];
            return;
        }
        const rows = [];

        this.tree.tagsets.forEach((tagset) => {
            rows.push({
                type: 'tagset', depth: 0, key: 'tagset-' + tagset.id,
                node: tagset
            });
            if (tagset.show) {
                tagset.tags.forEach((tag) => this.addTagRows(rows, tag, 1));
            }
        });

        this.tree.orphanTags.forEach((tag) => this.addTagRows(rows, tag, 0));

        this.tree.orphanRois.forEach(
            (roiNode) => this.addRoiRows(rows, roiNode, 0));

        this.rows = rows;
    }

    /**
     * Expands/collapses a Tagset, Tag, or Roi node.
     * @param {Object} node
     * @param {Object} event
     */
    toggleNode(node, event) {
        event.stopPropagation();
        node.show = !node.show;
        this.flatten();
    }

    /**
     * Collects all (live) Shape objects that fall under a given row,
     * i.e. all its descendant Shapes - a Shape row is just itself, a Roi
     * row is all its Shapes, a Tag row is all its Rois' Shapes plus its
     * directly tagged Shapes, and a Tagset row is all of its Tags'.
     *
     * @param {Object} row a row, as produced by flatten()
     * @return {Array.<Object>} the live shape objects found
     */
    collectShapes(row) {
        const shapes = [];
        const addRoiShapes = (roiNode) => {
            if (roiNode.roi && roiNode.roi.shapes instanceof Map) {
                roiNode.roi.shapes.forEach((s) => shapes.push(s));
            }
        };
        const addTagShapes = (tag) => {
            tag.rois.forEach(addRoiShapes);
            tag.shapes.forEach((s) => { if (s.shape) shapes.push(s.shape); });
        };

        if (row.type === 'shape') {
            if (row.node.shape) shapes.push(row.node.shape);
        } else if (row.type === 'roi') {
            addRoiShapes(row.node);
        } else if (row.type === 'tag') {
            addTagShapes(row.node);
        } else if (row.type === 'tagset') {
            row.node.tags.forEach(addTagShapes);
        }
        return shapes;
    }

    /**
     * Whether every Shape under a row is currently visible, used to drive
     * the row's visibility checkbox (no indeterminate/tri-state in v1).
     *
     * @param {Object} row a row, as produced by flatten()
     */
    isRowVisible(row) {
        return this.collectShapes(row).every((s) => s.visible);
    }

    /**
     * Batch-toggles the visibility of every Shape under a row.
     *
     * @param {Object} row a row, as produced by flatten()
     * @param {Object} event the mouse event object
     */
    toggleVisibility(row, event) {
        event.stopPropagation();
        const checked = !this.isRowVisible(row);
        const shape_ids = this.collectShapes(row)
            .filter((s) => s.visible !== checked)
            .map((s) => s.shape_id);
        if (shape_ids.length === 0) return true;
        this.context.publish(
            REGIONS_SET_PROPERTY, {
                config_id: this.regions_info.image_info.config_id,
                property: 'visible',
                shapes: shape_ids,
                value: checked
            });
        return true;
    }

    /**
     * Selects a Roi or Shape row, syncing selection/highlight with the
     * viewer and the ROIs tab. Mirrors selectShape() in regions-list.js,
     * simplified for this read-only navigation tab: single-select only,
     * always replacing the prior selection (no ctrl/shift multi-select).
     *
     * @param {Object} row a row, as produced by flatten()
     * @param {Object} event the mouse event object
    */
    selectRow(row, event) {
        // let the visibility checkbox handle its own clicks - returning
        // true (rather than undefined) stops Aurelia from calling
        // event.preventDefault(), which would otherwise cancel the
        // checkbox's native toggle before it can fire its own change event
        if (event.target.tagName.toUpperCase() === 'INPUT') return true;

        let shape_ids;
        if (row.type === 'roi') {
            if (row.node.missing || !(row.node.roi.shapes instanceof Map)) {
                return;
            }
            shape_ids = Array.from(row.node.roi.shapes.values())
                .map((s) => s.shape_id);
        } else if (row.type === 'shape') {
            if (row.node.missing) return;
            shape_ids = [row.node.shape.shape_id];
        } else {
            return;
        }
        if (shape_ids.length === 0) return;

        this.context.publish(
            REGIONS_SET_PROPERTY, {
                config_id: this.regions_info.image_info.config_id,
                property: 'selected',
                shapes: shape_ids,
                clear: true,
                value: true,
                center: true
            });
    }
}
