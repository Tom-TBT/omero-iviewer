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
        if (this.regions_ready_observer) {
            this.regions_ready_observer.dispose();
            this.regions_ready_observer = null;
        }
    }

    /**
     * Makes sure we (re)fetch/(re)build once regions_info.data is actually
     * ready, whether that's already the case or happens shortly after
     * (e.g. following an image switch).
     *
     * @memberof RegionsTags
     */
    waitForRegionsInfoReady() {
        if (this.regions_ready_observer) {
            this.regions_ready_observer.dispose();
            this.regions_ready_observer = null;
        }
        if (this.regions_info === null) return;

        const onceReady = () => {
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
                roiNode.roi.shapes.forEach((shape, shape_id) => {
                    rows.push({
                        type: 'shape', depth: depth + 2,
                        key: roiKey + '-shape-' + shape_id,
                        node: { shape, roi_id: roiNode.roi_id, shape_id }
                    });
                });
            }
        });
        tag.shapes.forEach((shapeRef) => {
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
            roiNode.roi.shapes.forEach((shape, shape_id) => {
                rows.push({
                    type: 'shape', depth: depth + 1,
                    key: roiKey + '-shape-' + shape_id,
                    node: { shape, roi_id: roiNode.roi_id, shape_id }
                });
            });
        }
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
}
