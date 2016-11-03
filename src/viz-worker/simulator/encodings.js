'use strict';

const _             = require('underscore');
const d3Scale       = require('d3-scale');
const d3Interpolate = require('d3-interpolate');
const Color         = require('color');

const defaults = {
    color: {
        isQuantitative: {
            sequential: {
                range: ['white', 'blue']
            },
            diverging: {
                range: ['blue', 'white', 'red']
            }
        }
    },
    pointSize: {
        range: [0, 30] // Range of diameters supported, per VGraphLoader
    },
    pointOpacity: {
        range: [0, 1]
    },
    edgeSize: {
        range: [0, 10]
    },
    edgeOpacity: {
        range: [0, 1]
    }
};

/** @typedef {Object} EncodingSpec
 * @property {String} scalingType linear, log, etc. from d3.scale, and identity
 * @property {Array} domain [min, max] structure for d3.scale
 * @property {Array} range [min, max] structure for d3.scale
 * @property {Boolean?} clamp
 */


/**
 * @param {Dataframe} dataframe
 * @returns Object.<String, EncodingSpec>
 */
function inferLoadedEncodingsFor(dataframe) {
}


/**
 * @param {Aggregations} summary
 * @param {String} variation
 * @param {Array} defaultDomain
 * @param {Array} distinctValues
 * @param {BinningResult} binning
 * @returns {EncodingSpec}
 */
function inferColorScalingSpecFor (summary, variation, defaultDomain, distinctValues, binning) {
    let scalingType, domain, range;
    const defaultSequentialRange = defaults.color.isQuantitative.sequential.range;
    if (summary.isCategorical) {
        if (variation === 'quantitative' && summary.isOrdered) {
            // User can request a quantitative interpretation of ordered categorical domains.
            if (summary.isNumeric) {
                scalingType = 'linear';
                domain = defaultDomain;
                range = defaultSequentialRange;
            } else if (binning.bins && _.size(binning.bins) > 0) {
                // A linear ordering has to trust bin order to make visual sense.
                if (binning.type === 'countBy') {
                    domain = _.sortBy(_.keys(binning.bins), (key) => {
                        return binning.bins[key];
                    });
                } else {
                    domain = distinctValues;
                }
            } else {
                domain = distinctValues;
            }
            if (range === undefined) {
                const interpolation = d3Interpolate.interpolate(defaultSequentialRange[0], defaultSequentialRange[1]),
                    numValues = domain.length;
                range = _.map(_.range(numValues), (idx) => Color(interpolation(idx / numValues)).hexString());
                scalingType = 'ordinal';
            }
        } else if (summary.countDistinct < 10) {
            scalingType = 'category10';
            domain = distinctValues;
        } else { // if (summary.countDistinct < 20) {
            scalingType = 'category20';
            domain = distinctValues;
        }
    } else if (summary.isOrdered) {
        if (summary.isDiverging) {
            scalingType = 'linear';
            domain = defaultDomain;
            range = defaults.color.isQuantitative.diverging.range;
        } else {
            scalingType = 'linear';
            domain = defaultDomain;
            range = defaultSequentialRange;
        }
    }
    return {
        scalingType: scalingType,
        domain: domain,
        range: range
    };
}


/**
 * @param {Dataframe} dataframe
 * @param {GraphComponentTypes} type
 * @param {String} attributeName
 * @returns {EncodingSpec}
 */
function inferEncodingType (dataframe, type, attributeName) {
    const aggregations = dataframe.getColumnAggregations(attributeName, type, true);
    const summary = aggregations.getSummary();
    let encodingType;
    switch (type) {
        case 'point':
            if (summary.isPositive) {
                encodingType = 'pointSize';
            } else {
                encodingType = 'pointColor';
            }
            break;
        case 'edge':
            if (summary.isPositive) {
                encodingType = 'edgeSize';
            } else {
                encodingType = 'edgeColor';
            }
    }
    return encodingType;
}

/**
 * @param {EncodingSpec} scalingSpec
 * @returns {d3.scale}
 */
function scalingFromSpec (scalingSpec) {
    const scalingType = scalingSpec.scalingType;
    let scaling;
    if (d3Scale[scalingType] !== undefined) {
        scaling = d3Scale[scalingType]();
    } else if (scalingType === 'identity') {
        scaling = _.identity;
    }
    if (scaling === undefined) {
        scaling = d3Scale.linear();
    }
    if (scalingSpec.domain !== undefined) {
        scaling.domain(scalingSpec.domain);
    }
    if (scalingSpec.range !== undefined) {
        scaling.range(scalingSpec.range);
    }
    if (scalingSpec.clamp !== undefined) {
        scaling.clamp(scalingSpec.clamp);
    }
    return scaling;
}

function domainIsPositive (aggregations) {
    return aggregations.getAggregationByType('isPositive');
}

/**
 * @param {EncodingSpec?} encodingSpec
 * @param {ColumnAggregation} aggregations
 * @param {String} attributeName
 * @param {String} encodingType
 * @param {String} variation
 * @param {Binning} binning
 * @returns {EncodingSpec}
 */
function inferEncodingSpec (encodingSpec, aggregations, attributeName, encodingType, variation, binning) {
    const summary = aggregations.getSummary();
    let scalingType, domain, range, clamp;
    const defaultDomain = [summary.minValue, summary.maxValue];
    const distinctValues = _.map(summary.distinctValues, (x) => x.distinctValue);
    switch (encodingType) {
        case 'size':
        case 'pointSize':
            // Has to have a magnitude, not negative:
            if (domainIsPositive(aggregations)) {
                // Square root because point size/radius yields a point area:
                scalingType = 'sqrt';
                domain = defaultDomain;
                range = defaults.pointSize.range;
                clamp = true;
            }
            break;
        case 'edgeSize':
            // TODO ensure sizes are binned/scaled so that they may be visually distinguished.
            if (domainIsPositive(aggregations)) {
                scalingType = 'linear';
                domain = defaultDomain;
                range = defaults.edgeSize.range;
                clamp = true;
            }
            break;
        case 'opacity':
        case 'pointOpacity':
        case 'edgeOpacity':
            // Has to have a magnitude, not negative:
            if (domainIsPositive(aggregations)) {
                scalingType = 'linear';
                domain = defaultDomain;
                range = defaults.pointOpacity.range;
            }
            break;
        case 'color':
        case 'pointColor':
        case 'edgeColor':
            // Minimally support using columns with color in the name as their own palettes.
            // Assumes direct RGBA int32 values for now.
            if (attributeName.match(/color/i)) {
                scalingType = 'identity';
                domain = distinctValues;
                range = distinctValues;
            } else {
                return inferColorScalingSpecFor(summary, variation, defaultDomain, distinctValues, binning);
            }
            break;
        case 'title':
        case 'pointTitle':
        case 'edgeTitle':
            break;
        case 'label':
        case 'pointLabel':
        case 'edgeLabel':
            break;
        default:
            throw new Error('No encoding found for: ' + encodingType);
    }
    return _.defaults(encodingSpec || {}, {
        scalingType: scalingType,
        domain: domain,
        range: range,
        clamp: clamp
    });
}

/** A legend per the binning; assigns a range member per bin.
 * @returns <Array>
 */
function legendForBins (aggregations, scaling, binning) {
    let legend;
    const summary = aggregations.getSummary();
    if (scaling !== undefined && binning !== undefined) {
        // All this just handles many shapes of binning metadata, kind of messy.
        const minValue = summary.minValue,
            step = binning.binWidth || 0,
            binValues = binning.binValues;
        // NOTE: Use the scaling to get hex string / number, not machine integer, for D3 color/size.
        if (binning.bins && _.size(binning.bins) > 0) {
            if (binning.type === 'countBy') {
                if (_.isArray(binning.bins)) {
                    if (_.isArray(binning.binValues)) {
                        legend = _.map(binning.binValues, (binValue) => scaling(binValue && binValue.representative));
                    } else {
                        legend = _.map(binning.bins, (itemCount, index) => scaling(index));
                    }
                } else {
                    // _other always shows last
                    const sortedBinKeys = _.sortBy(_.keys(binning.bins),
                        (key) => (key === '_other' ? Infinity : -binning.bins[key]));
                    legend = _.map(sortedBinKeys,
                        (key) => (key === '_other' ? undefined : scaling(key)));
                }
            } else if (summary.isNumeric) {
                legend = _.map(binning.bins, (itemCount, index) => scaling(minValue + step * index));
            } else {
                legend = _.map(binning.bins, (itemCount, index) => {
                    const value = binValues !== undefined && binValues[index] ? binValues[index] : index;
                    return scaling(value);
                });
            }
        } else {
            legend = new Array(binning.numBins);
            for (let i = 0; i < binning.numBins; i++) {
                legend[i] = scaling(minValue + step * i);
            }
        }
    }
    return legend;
}

/**
 * @param {Dataframe} dataframe
 * @param {String} columnName
 * @param {String} type
 * @param {String} encodingType
 * @returns {EncodingSpec}
 */
function getEncodingSpecFor (dataframe, columnName, type, encodingType) {
    const column = dataframe.getColumn(columnName, type);
    if (column === undefined) { return undefined; }
    const encodingPreferences = column.encodingPreferences;
    if (encodingPreferences === undefined) { return undefined; }
    if (encodingType === undefined) {
        return undefined;
    } else if (encodingPreferences.hasOwnProperty(encodingType)) {
        return encodingPreferences[encodingType];
    } else {
        return undefined;
    }
}


/**
 * @param {Dataframe} dataframe
 * @param {String} columnName
 * @param {GraphComponentTypes} type
 * @param {String} encodingType
 * @param {EncodingSpec} encodingSpec
 */
function saveEncodingSpec (dataframe, columnName, type, encodingType, encodingSpec) {
    const column = dataframe.getColumn(columnName, type);
    if (column === undefined) { return; }
    if (column.encodingPreferences === undefined) { column.encodingPreferences = {}; }
    const encodingPreferences = column.encodingPreferences;
    encodingPreferences[encodingType] = encodingSpec;
}


/**
 * @param {Dataframe} dataframe
 * @param {GraphComponentTypes} type
 * @param {String} attributeName
 * @param {String} encodingType
 * @param {String} variation
 * @param {Binning} binning
 * @returns {{legend: Array, scaling: d3.scale}}
 */
function inferEncoding (dataframe, type, attributeName, encodingType, variation, binning) {
    const aggregations = dataframe.getColumnAggregations(attributeName, type, true);
    let encodingSpec = getEncodingSpecFor(dataframe, attributeName, type, encodingType);
    encodingSpec = inferEncodingSpec(encodingSpec, aggregations, attributeName, encodingType, variation, binning);
    const scaling = scalingFromSpec(encodingSpec);
    const legend = legendForBins(aggregations, scaling, binning);
    return {
        legend: legend,
        scaling: scaling
    };
}

function inferTimeBoundEncoding (dataframe, type, attributeName, encodingType, timeBounds) {
    const scalingFunc = function (timeValue) {
        const {
            encodingBoundsA,
            encodingBoundsB,
            encodingBoundsC
        } = timeBounds;

        // if in C
        if (timeValue >= encodingBoundsC.start && timeValue <= encodingBoundsC.stop) {
            return '#9816C1';
        }

        // if in B
        if (timeValue >= encodingBoundsB.start && timeValue <= encodingBoundsB.stop) {
            // return '#2E37FE';
            return '#1A16C1';
        }

        // if in A
        if (timeValue >= encodingBoundsA.start && timeValue <= encodingBoundsA.stop) {
            // return '#FF3030';
            return '#C11616';
        }

        // Otherwise return light grey
        return '#8E8E8E';
    };

    return {
        scaling: scalingFunc,
        legend: undefined
    };
}

module.exports = {
    inferEncodingType: inferEncodingType,
    inferEncoding: inferEncoding,
    scalingFromSpec: scalingFromSpec,
    inferEncodingSpec: inferEncodingSpec,
    getEncodingSpecFor: getEncodingSpecFor,
    saveEncodingSpec: saveEncodingSpec,
    legendForBins: legendForBins,
    bufferNameForEncodingType: function (encodingType) {
        return encodingType && (encodingType + 's');
    },
    inferTimeBoundEncoding
};