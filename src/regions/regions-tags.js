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
import Misc from '../utils/misc';
import { IVIEWER, ROI_TABS, WEBCLIENT } from '../utils/constants';
import { REGIONS_SET_PROPERTY } from '../events/events';
import { inject, customElement, bindable, BindingEngine } from 'aurelia-framework';

/**
 * Indent (px) of a Roi row's tree-toggle, depending on the Roi's ancestry.
 */
const ROI_INDENT_UNDER_TAGSET = 45;
const ROI_INDENT_UNDER_ORPHAN_TAG = 32;
const ROI_INDENT_ORPHAN = 0;

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
     * the column shown alongside Z/T/C (mutually exclusive for now)
     * @memberof RegionsTags
     * @type {string}
     */
    active_column = 'comments';

    /**
     * The key of the last row clicked in selectRow(), used as the anchor
     * for shift-click range selection.
     * @type {String}
     */
    last_selected_row_key = null;

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
    }

    /**
     * Registers property observers
     *
     * @memberof RegionsTags
     */
    registerObservers() {
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
        // number_of_shapes changes whenever a Roi/Shape is drawn or
        // (un)deleted (regions-drawing.js/regions_info.js) - unlike
        // visibility/selection, this can add/remove an (orphan) Roi or
        // Shape the tree doesn't know about yet, so re-derive the tree
        // itself from tags_info + regions_info.data, not just re-flatten
        // the existing one.
        this.observers.push(
            this.bindingEngine.propertyObserver(
                this.regions_info, 'number_of_shapes')
                .subscribe(() => setTimeout(() => this.buildTree(), 0)));
    }

    /**
     * Unregisters the the observers (property and regions info ready)
     *
     * @param {boolean} property_only true if only property observers are cleaned up
     * @memberof RegionsTags
     */
    unregisterObservers(property_only = false) {
        this.observers.map((o) => { if (o) o.dispose(); });
        this.observers = [];
        if (property_only) return;
        if (this.regions_ready_observer) {
            this.regions_ready_observer.dispose();
            this.regions_ready_observer = null;
        }
    }

    /**
     * Makes sure that regions info data is there before fetching/building
     * this tab's tag tree
     *
     * @memberof RegionsTags
     */
    waitForRegionsInfoReady() {
        if (this.regions_info === null) return;

        let onceReady = () => {
            if (this.regions_info === null) return;
            // register observer
            this.registerObservers();
            if (this.selected_roi_tab !== ROI_TABS.ROI_TAGS) return;
            if (this.tags_info === null) this.requestData(true);
            else this.buildTree();
        };

        // tear down old observers
        this.unregisterObservers();
        if (this.regions_info.ready) {
            onceReady();
            return;
        }

        // we are not yet ready, wait for ready via observer. Unlike
        // regions-list.js's own version of this, we only act once ready
        // actually becomes true: onceReady() here fetches/builds against
        // regions_info.data, which is meaningless (or being cleared) while
        // ready is false.
        if (this.regions_ready_observer === null)
            this.regions_ready_observer =
                this.bindingEngine.propertyObserver(
                    this.regions_info, 'ready').subscribe(
                        (newValue, oldValue) => { if (newValue) onceReady(); });
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
     * Css classes for a shape's type icon (rectangle/ellipse/line/...),
     * matching the classes used in regions-list.html. Empty for rows that
     * are not a real, present shape.
     * @param {Object} row
     */
    shapeIconClass(row) {
        if (row.type !== 'shape' || row.node.missing) return '';
        let shape = row.node.shape;
        let markerStart =
            typeof shape.MarkerStart === 'string' ?
                shape.MarkerStart.toLowerCase() : '';
        let markerEnd =
            typeof shape.MarkerEnd === 'string' ?
                shape.MarkerEnd.toLowerCase() : '';
        return shape.type.toLowerCase() + '-icon marker-' +
            markerStart + markerEnd;
    }

    /**
     * Formats a marshalled owner (omero:details.owner, as returned for
     * Tags/Tagsets by the image_tags view) the same way Shape owners are
     * formatted in converters.js: "Firstname Lastname", falling back to
     * the username if both are blank.
     * @param {Object} owner
     */
    formatOwner(owner) {
        if (!owner) return '';
        let first = typeof owner.FirstName === 'string' ? owner.FirstName : '';
        let last = typeof owner.LastName === 'string' ? owner.LastName : '';
        let user = typeof owner.UserName === 'string' ? owner.UserName : '';
        return (first === '' && last === '') ? user : (first + ' ' + last);
    }

    /**
     * Tooltip text for a row, matching the "ROI: x, Shape: y\nOwner: ..."
     * convention used in regions-list.html.
     * @param {Object} row
     */
    rowTooltip(row) {
        if (row.type === 'tagset') {
            let owner = this.formatOwner(row.node.owner);
            return 'Tagset: ' + row.node.id + (owner ? '\nOwner: ' + owner : '');
        }
        if (row.type === 'tag') {
            let owner = this.formatOwner(row.node.owner);
            return 'Tag: ' + row.node.id + (owner ? '\nOwner: ' + owner : '');
        }
        if (row.type === 'roi') {
            if (row.node.missing) return 'ROI: ' + row.node.roi_id;
            let shape = this.firstShape(row.node.roi);
            let owner = shape ? shape.owner : '';
            return 'ROI: ' + row.node.roi_id +
                (owner ? '\nOwner: ' + owner : '');
        }
        if (row.type === 'shape') {
            if (row.node.missing) {
                return 'ROI: ' + row.node.roi_id +
                    ', Shape: ' + row.node.shape_id;
            }
            let owner = row.node.shape.owner;
            return 'ROI: ' + row.node.roi_id + ', Shape: ' + row.node.shape_id +
                (owner ? '\nOwner: ' + owner : '');
        }
        return '';
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
            return {
                id: tag_id, text: tag.text, owner: tag.owner,
                show: true, rois, shapes
            };
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
                {
                    id: tagset.id, text: tagset.text, owner: tagset.owner,
                    show: true, tags: []
                });
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
     * Depth (indent level) is fixed per role in the conceptual
     * Tagset(0) > Tag(1) > Roi(2) > Shape(3) hierarchy, regardless of which
     * ancestors actually exist on a given branch - the arrow's own
     * padding-left uses this, within a single fixed-width "Show" column
     * (see .tags-show in app.css). A Shape directly tagged (not nested in a
     * Roi) sits at the Roi depth, since it's a sibling of Roi nodes under
     * the same Tag.
     *
     * A Roi row's indent (px) is the one exception: it varies with the
     * Roi's actual ancestry rather than a fixed depth, so a Roi reads as
     * more/less nested depending on whether it sits under a Tagset, an
     * orphan Tag, or is itself a top-level orphan Roi (see the
     * ROI_INDENT_* constants above the class).
     */

    /**
     * Number of (non-deleted) Shapes a Roi has.
     * @param {Object} roi a live Roi object from regions_info.data
     * @return {Number}
     */
    roiShapeCount(roi) {
        if (!roi || !(roi.shapes instanceof Map)) return 0;
        return roi.shapes.size - (roi.deleted || 0);
    }

    /**
     * The first non-deleted Shape of a Roi, or null.
     * @param {Object} roi a live Roi object from regions_info.data
     */
    firstShape(roi) {
        if (!roi || !(roi.shapes instanceof Map)) return null;
        for (const shape of roi.shapes.values()) {
            if (!shape.deleted) return shape;
        }
        return null;
    }

    /**
     * Adds the rows for a Tag node (and, if expanded, its Roi/Shape
     * children) to the given rows array.
     * @param {Array.<Object>} rows
     * @param {Object} tag
     * @param {Number} depth 1 if under a Tagset, 0 if an orphan Tag - a
     *   Tag row's depth is purely a visual nesting cue (unlike Roi/Shape
     *   depths, it doesn't need to line up with any Z/T/C/... columns), so
     *   it's allowed to vary with the Tag's actual ancestry: an orphan Tag
     *   should read as top-level, not as if it were nested under whichever
     *   Tagset happens to be listed above it
     * @param {Number} roiIndent indent (px) to use for this Tag's Roi rows
     */
    addTagRows(rows, tag, depth, roiIndent) {
        rows.push({ type: 'tag', depth, key: 'tag-' + tag.id, node: tag });
        if (!tag.show) return;
        tag.rois.forEach((roiNode) => this.addRoiRows(
            rows, roiNode, 'tagroi-' + tag.id + '-' + roiNode.roi_id,
            roiIndent));
        this.sortShapeRefs(tag.shapes, (e) => e.shape).forEach((shapeRef) => {
            rows.push({
                type: 'shape', depth: 2,
                key: 'tagshape-' + tag.id + '-' + shapeRef.shape_id,
                node: shapeRef
            });
        });
    }

    /**
     * Adds the rows for a Roi node (and, if expanded, its Shapes) to the
     * given rows array. A Roi with exactly one (non-deleted) Shape shows
     * that Shape's row directly instead, matching the ROIs tab.
     * @param {Array.<Object>} rows
     * @param {Object} roiNode
     * @param {String} roiKey
     * @param {Number} indent indent (px) for this Roi row's tree-toggle
     */
    addRoiRows(rows, roiNode, roiKey, indent) {
        const shape = !roiNode.missing && this.roiShapeCount(roiNode.roi) === 1 ?
            this.firstShape(roiNode.roi) : null;
        if (shape) {
            rows.push({
                type: 'shape', depth: 2, key: roiKey + '-onlyshape',
                node: {
                    shape, roi_id: roiNode.roi_id, shape_id: shape['@id']
                }
            });
            return;
        }
        rows.push({ type: 'roi', indent, key: roiKey, node: roiNode });
        if (roiNode.show && roiNode.roi &&
            roiNode.roi.shapes instanceof Map) {
            const shapes = this.sortShapeRefs(
                Array.from(roiNode.roi.shapes.values()), (s) => s);
            shapes.forEach((shape) => {
                const shape_id = shape['@id'];
                rows.push({
                    type: 'shape', depth: 3,
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
        const attrMap = {
            theZ: 'TheZ', theT: 'TheT', theC: 'TheC',
            area: 'Area', length: 'Length'
        };
        const value = shape[attrMap[this.sortBy]];
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

    sortCss(sortBy, sortAscending, attrName) {
        if (attrName !== sortBy) return 'sortable';
        return sortAscending ? 'sortable asc' : 'sortable desc';
    }

    /**
     * Show/Hide all shapes in the image (not just the ones shown in this
     * tab's tree)
     *
     * @param {Object} event the mouse event object
     * @memberof RegionsTags
     */
    toggleAllShapesVisibility(event) {
        event.stopPropagation();
        let show = event.target.checked;
        if (this.regions_info.number_of_shapes === 0) return;
        let ids = [];
        this.regions_info.data.forEach(
            (roi) =>
                roi.shapes.forEach(
                    (shape) => {
                        if (shape.visible !== show &&
                            !(shape.deleted &&
                            typeof shape.is_new === 'boolean' && shape.is_new))
                                ids.push(shape.shape_id);
                    })
        );
        this.context.publish(
           REGIONS_SET_PROPERTY, {
               config_id: this.regions_info.image_info.config_id,
               property : "visible",
               shapes : ids, value : show});
    }

    /**
     * Selects column (mutually exclusive for now)
     *
     * @param {string} which the column name
     * @memberof RegionsTags
     */
    showColumn(which) {
        if (typeof which !== 'string' || which.length === 0 ||
            which === this.active_column) return;
        this.active_column = which;
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
                tagset.tags.forEach((tag) => this.addTagRows(
                    rows, tag, 1, ROI_INDENT_UNDER_TAGSET));
            }
        });

        this.tree.orphanTags.forEach((tag) => this.addTagRows(
            rows, tag, 0, ROI_INDENT_UNDER_ORPHAN_TAG));

        this.tree.orphanRois.forEach(
            (roiNode) => this.addRoiRows(
                rows, roiNode, 'orphanroi-' + roiNode.roi_id,
                ROI_INDENT_ORPHAN));

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
     * Selects a row, syncing selection/highlight with the viewer and the
     * ROIs tab. Mirrors selectShape() in regions-list.js: ctrl/cmd adds to
     * (or, if already fully selected, removes from) the current selection;
     * shift selects the range between the last-clicked row and this one.
     * Unlike regions-list.js (which has no ordered array of its own and
     * has to walk the DOM to find that range), this tab already keeps
     * this.rows in display order, so the range is just an index slice.
     * A Tag/Tagset row selects every Shape beneath it (via collectShapes),
     * same as a multi-Shape Roi row does.
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

        // expand a collapsed Roi, so the newly-selected Shapes are visible
        if (row.type === 'roi' && !row.node.missing && !row.node.show) {
            row.node.show = true;
            this.flatten();
        }

        let cmdKey = Misc.isApple() ? 'metaKey' : 'ctrlKey';
        let ctrl = typeof event[cmdKey] === 'boolean' && event[cmdKey];
        let shift = event.shiftKey;
        let multipleSelection = ctrl;

        let shapes;
        if (shift && this.last_selected_row_key !== null) {
            let startIdx = this.rows.findIndex(
                (r) => r.key === this.last_selected_row_key);
            let endIdx = this.rows.findIndex((r) => r.key === row.key);
            if (startIdx !== -1 && endIdx !== -1) {
                let lo = Math.min(startIdx, endIdx);
                let hi = Math.max(startIdx, endIdx);
                shapes = [];
                const seen = new Set();
                for (let i = lo; i <= hi; i++) {
                    this.collectShapes(this.rows[i]).forEach((s) => {
                        if (!seen.has(s.shape_id)) {
                            seen.add(s.shape_id);
                            shapes.push(s);
                        }
                    });
                }
            }
        }
        if (typeof shapes === 'undefined') shapes = this.collectShapes(row);
        let shape_ids = shapes.map((s) => s.shape_id);
        if (shape_ids.length === 0) return true;

        let allSelected = shape_ids.every(
            (id) => this.regions_info.selected_shapes.indexOf(id) !== -1);
        let deselect = multipleSelection && allSelected;

        if (!shift) this.last_selected_row_key = row.key;

        this.context.publish(
            REGIONS_SET_PROPERTY, {
                config_id: this.regions_info.image_info.config_id,
                property: 'selected',
                shapes: shape_ids,
                clear: !multipleSelection,
                value: !deselect,
                center: !multipleSelection
            });
        return true;
    }
}
