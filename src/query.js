const _ = require('underscore');
const debug = require('debug')('leancloud:query');
const Promise = require('./promise');
const AVError = require('./error');
const { _request, request } = require('./request');
const { ensureArray, transformFetchOptions } = require('./utils');

const requires = (value, message) => {
  if (value === undefined) {
    throw new Error(message);
  }
};

// AV.Query is a way to create a list of AV.Objects.
module.exports = function(AV) {
  /**
   * Creates a new AV.Query for the given AV.Object subclass.
   * @param {Class|String} objectClass An instance of a subclass of AV.Object, or a AV className string.
   * @class
   *
   * <p>AV.Query defines a query that is used to fetch AV.Objects. The
   * most common use case is finding all objects that match a query through the
   * <code>find</code> method. For example, this sample code fetches all objects
   * of class <code>MyClass</code>. It calls a different function depending on
   * whether the fetch succeeded or not.
   *
   * <pre>
   * var query = new AV.Query(MyClass);
   * query.find().then(function(results) {
   *   // results is an array of AV.Object.
   * }, function(error) {
   *   // error is an instance of AVError.
   * });</pre></p>
   *
   * <p>An AV.Query can also be used to retrieve a single object whose id is
   * known, through the get method. For example, this sample code fetches an
   * object of class <code>MyClass</code> and id <code>myId</code>. It calls a
   * different function depending on whether the fetch succeeded or not.
   *
   * <pre>
   * var query = new AV.Query(MyClass);
   * query.get(myId).then(function(object) {
   *   // object is an instance of AV.Object.
   * }, function(error) {
   *   // error is an instance of AVError.
   * });</pre></p>
   *
   * <p>An AV.Query can also be used to count the number of objects that match
   * the query without retrieving all of those objects. For example, this
   * sample code counts the number of objects of the class <code>MyClass</code>
   * <pre>
   * var query = new AV.Query(MyClass);
   * query.count().then(function(number) {
   *   // There are number instances of MyClass.
   * }, function(error) {
   *   // error is an instance of AVError.
   * });</pre></p>
   */
  AV.Query = function(objectClass) {
    if (_.isString(objectClass)) {
      objectClass = AV.Object._getSubclass(objectClass);
    }

    this.objectClass = objectClass;

    this.className = objectClass.prototype.className;

    this._where = {};
    this._include = [];
    this._select = [];
    this._limit = -1; // negative limit means, do not send a limit
    this._skip = 0;
    this._extraOptions = {};
  };

  /**
   * Constructs a AV.Query that is the OR of the passed in queries.  For
   * example:
   * <pre>var compoundQuery = AV.Query.or(query1, query2, query3);</pre>
   *
   * will create a compoundQuery that is an or of the query1, query2, and
   * query3.
   * @param {...AV.Query} var_args The list of queries to OR.
   * @return {AV.Query} The query that is the OR of the passed in queries.
   */
  AV.Query.or = function() {
    var queries = _.toArray(arguments);
    var className = null;
    AV._arrayEach(queries, function(q) {
      if (_.isNull(className)) {
        className = q.className;
      }

      if (className !== q.className) {
        throw new Error('All queries must be for the same class');
      }
    });
    var query = new AV.Query(className);
    query._orQuery(queries);
    return query;
  };

  /**
   * Constructs a AV.Query that is the AND of the passed in queries.  For
   * example:
   * <pre>var compoundQuery = AV.Query.and(query1, query2, query3);</pre>
   *
   * will create a compoundQuery that is an 'and' of the query1, query2, and
   * query3.
   * @param {...AV.Query} var_args The list of queries to AND.
   * @return {AV.Query} The query that is the AND of the passed in queries.
   */
  AV.Query.and = function() {
    var queries = _.toArray(arguments);
    var className = null;
    AV._arrayEach(queries, function(q) {
      if (_.isNull(className)) {
        className = q.className;
      }

      if (className !== q.className) {
        throw new Error('All queries must be for the same class');
      }
    });
    var query = new AV.Query(className);
    query._andQuery(queries);
    return query;
  };

  /**
   * Retrieves a list of AVObjects that satisfy the CQL.
   * CQL syntax please see {@link https://leancloud.cn/docs/cql_guide.html CQL Guide}.
   *
   * @param {String} cql A CQL string, see {@link https://leancloud.cn/docs/cql_guide.html CQL Guide}.
   * @param {Array} pvalues An array contains placeholder values.
   * @param {AuthOptions} options
   * @return {Promise} A promise that is resolved with the results when
   * the query completes.
   */
  AV.Query.doCloudQuery = function(cql, pvalues, options) {
    var params = { cql: cql };
    if (_.isArray(pvalues)) {
      params.pvalues = pvalues;
    } else {
      options = pvalues;
    }

    var request = _request('cloudQuery', null, null, 'GET', params, options);
    return request.then(function(response) {
      //query to process results.
      var query = new AV.Query(response.className);
      var results = _.map(response.results, function(json) {
        var obj = query._newObject(response);
        if (obj._finishFetch) {
          obj._finishFetch(query._processResult(json), true);
        }
        return obj;
      });
      return {
        results: results,
        count: response.count,
        className: response.className,
      };
    });
  };

  AV.Query._extend = AV._extend;

  _.extend(
    AV.Query.prototype,
    /** @lends AV.Query.prototype */ {
      //hook to iterate result. Added by dennis<xzhuang@avoscloud.com>.
      _processResult: function(obj) {
        return obj;
      },

      /**
       * Constructs an AV.Object whose id is already known by fetching data from
       * the server.
       *
       * @param {String} objectId The id of the object to be fetched.
       * @param {AuthOptions} options
       * @return {Promise.<AV.Object>}
       */
      get: function(objectId, options) {
        if (!_.isString(objectId)) {
          throw new Error('objectId must be a string');
        }
        if (objectId === '') {
          return Promise.reject(
            new AVError(AVError.OBJECT_NOT_FOUND, 'Object not found.')
          );
        }

        var obj = this._newObject();
        obj.id = objectId;

        var queryJSON = this.toJSON();
        var fetchOptions = {};

        if (queryJSON.keys) fetchOptions.keys = queryJSON.keys;
        if (queryJSON.include) fetchOptions.include = queryJSON.include;
        if (queryJSON.includeACL)
          fetchOptions.includeACL = queryJSON.includeACL;

        return _request(
          'classes',
          this.className,
          objectId,
          'GET',
          transformFetchOptions(fetchOptions),
          options
        ).then(response => {
          if (_.isEmpty(response))
            throw new AVError(AVError.OBJECT_NOT_FOUND, 'Object not found.');
          obj._finishFetch(obj.parse(response), true);
          return obj;
        });
      },

      /**
       * Returns a JSON representation of this query.
       * @return {Object}
       */
      toJSON: function() {
        var params = {
          where: this._where,
        };

        if (this._include.length > 0) {
          params.include = this._include.join(',');
        }
        if (this._select.length > 0) {
          params.keys = this._select.join(',');
        }
        if (this._includeACL !== undefined) {
          params.returnACL = this._includeACL;
        }
        if (this._limit >= 0) {
          params.limit = this._limit;
        }
        if (this._skip > 0) {
          params.skip = this._skip;
        }
        if (this._order !== undefined) {
          params.order = this._order;
        }

        AV._objectEach(this._extraOptions, function(v, k) {
          params[k] = v;
        });

        return params;
      },

      _newObject: function(response) {
        var obj;
        if (response && response.className) {
          obj = new AV.Object(response.className);
        } else {
          obj = new this.objectClass();
        }
        return obj;
      },
      _createRequest(
        params = this.toJSON(),
        options,
        path = `/classes/${this.className}`
      ) {
        if (encodeURIComponent(JSON.stringify(params)).length > 2000) {
          const body = {
            requests: [
              {
                method: 'GET',
                path: `/1.1${path}`,
                params,
              },
            ],
          };
          return request({
            path: '/batch',
            method: 'POST',
            data: body,
            authOptions: options,
          }).then(response => {
            const result = response[0];
            if (result.success) {
              return result.success;
            }
            const error = new Error(
              result.error.error || 'Unknown batch error'
            );
            error.code = result.error.code;
            throw error;
          });
        }
        return request({
          method: 'GET',
          path,
          query: params,
          authOptions: options,
        });
      },

      _parseResponse(response) {
        return _.map(response.results, json => {
          var obj = this._newObject(response);
          if (obj._finishFetch) {
            obj._finishFetch(this._processResult(json), true);
          }
          return obj;
        });
      },

      /**
       * Retrieves a list of AVObjects that satisfy this query.
       *
       * @param {AuthOptions} options
       * @return {Promise} A promise that is resolved with the results when
       * the query completes.
       */
      find(options) {
        const request = this._createRequest(undefined, options);
        return request.then(this._parseResponse.bind(this));
      },

      /**
       * scan a Query. masterKey required.
       *
       * @since 2.1.0
       * @param {object} [options]
       * @param {string} [options.orderedBy] specify the key to sort
       * @param {number} [options.batchSize] specify the batch size for each request
       * @param {AuthOptions} [authOptions]
       * @return {AsyncIterator.<AV.Object>}
       * @example const scan = new AV.Query(TestClass).scan({
       *   orderedBy: 'objectId',
       *   batchSize: 10,
       * }, {
       *   useMasterKey: true,
       * });
       * const getTen = () => Promise.all(new Array(10).fill(0).map(() => scan.next()));
       * getTen().then(results => {
       *   // results are fisrt 10 instances of TestClass
       *   return getTen();
       * }).then(results => {
       *   // 11 - 20
       * });
       */
      scan({ orderedBy, batchSize } = {}, authOptions) {
        const condition = this.toJSON();
        debug('scan %O', condition);
        if (condition.order) {
          console.warn(
            'The order of the query is ignored for Query#scan. Checkout the orderedBy option of Query#scan.'
          );
          delete condition.order;
        }
        if (condition.skip) {
          console.warn(
            'The skip option of the query is ignored for Query#scan.'
          );
          delete condition.skip;
        }
        if (condition.limit) {
          console.warn(
            'The limit option of the query is ignored for Query#scan.'
          );
          delete condition.limit;
        }
        if (orderedBy) condition.scan_key = orderedBy;
        if (batchSize) condition.limit = batchSize;
        let promise = Promise.resolve([]);
        let cursor;
        let done = false;
        return {
          next: () => {
            promise = promise.then(remainResults => {
              if (done) return [];
              if (remainResults.length > 1) return remainResults;
              // no cursor means we have reached the end
              // except for the first time
              if (!cursor && remainResults.length !== 0) {
                done = true;
                return remainResults;
              }
              // when only 1 item left in queue
              // start the next request to see if it is the last one
              return _request(
                'scan/classes',
                this.className,
                null,
                'GET',
                cursor ? _.extend({}, condition, { cursor }) : condition,
                authOptions
              )
                .then(response => {
                  cursor = response.cursor;
                  return this._parseResponse(response);
                })
                .then(results => {
                  if (!results.length) done = true;
                  return remainResults.concat(results);
                });
            });
            return promise
              .then(remainResults => remainResults.shift())
              .then(result => ({
                value: result,
                done,
              }));
          },
        };
      },

      /**
       * Delete objects retrieved by this query.
       * @param {AuthOptions} options
       * @return {Promise} A promise that is fulfilled when the save
       *     completes.
       */
      destroyAll: function(options) {
        var self = this;
        return self.find(options).then(function(objects) {
          return AV.Object.destroyAll(objects, options);
        });
      },

      /**
       * Counts the number of objects that match this query.
       *
       * @param {AuthOptions} options
       * @return {Promise} A promise that is resolved with the count when
       * the query completes.
       */
      count: function(options) {
        var params = this.toJSON();
        params.limit = 0;
        params.count = 1;
        var request = this._createRequest(params, options);

        return request.then(function(response) {
          return response.count;
        });
      },

      /**
       * Retrieves at most one AV.Object that satisfies this query.
       *
       * @param {AuthOptions} options
       * @return {Promise} A promise that is resolved with the object when
       * the query completes.
       */
      first: function(options) {
        var self = this;

        var params = this.toJSON();
        params.limit = 1;
        var request = this._createRequest(params, options);

        return request.then(function(response) {
          return _.map(response.results, function(json) {
            var obj = self._newObject();
            if (obj._finishFetch) {
              obj._finishFetch(self._processResult(json), true);
            }
            return obj;
          })[0];
        });
      },

      /**
       * Sets the number of results to skip before returning any results.
       * This is useful for pagination.
       * Default is to skip zero results.
       * @param {Number} n the number of results to skip.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      skip: function(n) {
        requires(n, 'undefined is not a valid skip value');
        this._skip = n;
        return this;
      },

      /**
       * Sets the limit of the number of results to return. The default limit is
       * 100, with a maximum of 1000 results being returned at a time.
       * @param {Number} n the number of results to limit to.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      limit: function(n) {
        requires(n, 'undefined is not a valid limit value');
        this._limit = n;
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be equal to the provided value.
       * @param {String} key The key to check.
       * @param value The value that the AV.Object must contain.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      equalTo: function(key, value) {
        requires(key, 'undefined is not a valid key');
        requires(value, 'undefined is not a valid value');
        this._where[key] = AV._encode(value);
        return this;
      },

      /**
       * Helper for condition queries
       * @private
       */
      _addCondition: function(key, condition, value) {
        requires(key, 'undefined is not a valid condition key');
        requires(condition, 'undefined is not a valid condition');
        requires(value, 'undefined is not a valid condition value');

        // Check if we already have a condition
        if (!this._where[key]) {
          this._where[key] = {};
        }
        this._where[key][condition] = AV._encode(value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular
       * <strong>array</strong> key's length to be equal to the provided value.
       * @param {String} key The array key to check.
       * @param value The length value.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      sizeEqualTo: function(key, value) {
        this._addCondition(key, '$size', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be not equal to the provided value.
       * @param {String} key The key to check.
       * @param value The value that must not be equalled.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      notEqualTo: function(key, value) {
        this._addCondition(key, '$ne', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be less than the provided value.
       * @param {String} key The key to check.
       * @param value The value that provides an upper bound.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      lessThan: function(key, value) {
        this._addCondition(key, '$lt', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be greater than the provided value.
       * @param {String} key The key to check.
       * @param value The value that provides an lower bound.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      greaterThan: function(key, value) {
        this._addCondition(key, '$gt', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be less than or equal to the provided value.
       * @param {String} key The key to check.
       * @param value The value that provides an upper bound.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      lessThanOrEqualTo: function(key, value) {
        this._addCondition(key, '$lte', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be greater than or equal to the provided value.
       * @param {String} key The key to check.
       * @param value The value that provides an lower bound.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      greaterThanOrEqualTo: function(key, value) {
        this._addCondition(key, '$gte', value);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * be contained in the provided list of values.
       * @param {String} key The key to check.
       * @param {Array} values The values that will match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      containedIn: function(key, values) {
        this._addCondition(key, '$in', values);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * not be contained in the provided list of values.
       * @param {String} key The key to check.
       * @param {Array} values The values that will not match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      notContainedIn: function(key, values) {
        this._addCondition(key, '$nin', values);
        return this;
      },

      /**
       * Add a constraint to the query that requires a particular key's value to
       * contain each one of the provided list of values.
       * @param {String} key The key to check.  This key's value must be an array.
       * @param {Array} values The values that will match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      containsAll: function(key, values) {
        this._addCondition(key, '$all', values);
        return this;
      },

      /**
       * Add a constraint for finding objects that contain the given key.
       * @param {String} key The key that should exist.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      exists: function(key) {
        this._addCondition(key, '$exists', true);
        return this;
      },

      /**
       * Add a constraint for finding objects that do not contain a given key.
       * @param {String} key The key that should not exist
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      doesNotExist: function(key) {
        this._addCondition(key, '$exists', false);
        return this;
      },

      /**
       * Add a regular expression constraint for finding string values that match
       * the provided regular expression.
       * This may be slow for large datasets.
       * @param {String} key The key that the string to match is stored in.
       * @param {RegExp} regex The regular expression pattern to match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      matches: function(key, regex, modifiers) {
        this._addCondition(key, '$regex', regex);
        if (!modifiers) {
          modifiers = '';
        }
        // Javascript regex options support mig as inline options but store them
        // as properties of the object. We support mi & should migrate them to
        // modifiers
        if (regex.ignoreCase) {
          modifiers += 'i';
        }
        if (regex.multiline) {
          modifiers += 'm';
        }

        if (modifiers && modifiers.length) {
          this._addCondition(key, '$options', modifiers);
        }
        return this;
      },

      /**
       * Add a constraint that requires that a key's value matches a AV.Query
       * constraint.
       * @param {String} key The key that the contains the object to match the
       *                     query.
       * @param {AV.Query} query The query that should match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      matchesQuery: function(key, query) {
        var queryJSON = query.toJSON();
        queryJSON.className = query.className;
        this._addCondition(key, '$inQuery', queryJSON);
        return this;
      },

      /**
       * Add a constraint that requires that a key's value not matches a
       * AV.Query constraint.
       * @param {String} key The key that the contains the object to match the
       *                     query.
       * @param {AV.Query} query The query that should not match.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      doesNotMatchQuery: function(key, query) {
        var queryJSON = query.toJSON();
        queryJSON.className = query.className;
        this._addCondition(key, '$notInQuery', queryJSON);
        return this;
      },

      /**
       * Add a constraint that requires that a key's value matches a value in
       * an object returned by a different AV.Query.
       * @param {String} key The key that contains the value that is being
       *                     matched.
       * @param {String} queryKey The key in the objects returned by the query to
       *                          match against.
       * @param {AV.Query} query The query to run.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      matchesKeyInQuery: function(key, queryKey, query) {
        var queryJSON = query.toJSON();
        queryJSON.className = query.className;
        this._addCondition(key, '$select', { key: queryKey, query: queryJSON });
        return this;
      },

      /**
       * Add a constraint that requires that a key's value not match a value in
       * an object returned by a different AV.Query.
       * @param {String} key The key that contains the value that is being
       *                     excluded.
       * @param {String} queryKey The key in the objects returned by the query to
       *                          match against.
       * @param {AV.Query} query The query to run.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      doesNotMatchKeyInQuery: function(key, queryKey, query) {
        var queryJSON = query.toJSON();
        queryJSON.className = query.className;
        this._addCondition(key, '$dontSelect', {
          key: queryKey,
          query: queryJSON,
        });
        return this;
      },

      /**
       * Add constraint that at least one of the passed in queries matches.
       * @param {Array} queries
       * @return {AV.Query} Returns the query, so you can chain this call.
       * @private
       */
      _orQuery: function(queries) {
        var queryJSON = _.map(queries, function(q) {
          return q.toJSON().where;
        });

        this._where.$or = queryJSON;
        return this;
      },

      /**
       * Add constraint that both of the passed in queries matches.
       * @param {Array} queries
       * @return {AV.Query} Returns the query, so you can chain this call.
       * @private
       */
      _andQuery: function(queries) {
        var queryJSON = _.map(queries, function(q) {
          return q.toJSON().where;
        });

        this._where.$and = queryJSON;
        return this;
      },

      /**
       * Converts a string into a regex that matches it.
       * Surrounding with \Q .. \E does this, we just need to escape \E's in
       * the text separately.
       * @private
       */
      _quote: function(s) {
        return '\\Q' + s.replace('\\E', '\\E\\\\E\\Q') + '\\E';
      },

      /**
       * Add a constraint for finding string values that contain a provided
       * string.  This may be slow for large datasets.
       * @param {String} key The key that the string to match is stored in.
       * @param {String} substring The substring that the value must contain.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      contains: function(key, value) {
        this._addCondition(key, '$regex', this._quote(value));
        return this;
      },

      /**
       * Add a constraint for finding string values that start with a provided
       * string.  This query will use the backend index, so it will be fast even
       * for large datasets.
       * @param {String} key The key that the string to match is stored in.
       * @param {String} prefix The substring that the value must start with.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      startsWith: function(key, value) {
        this._addCondition(key, '$regex', '^' + this._quote(value));
        return this;
      },

      /**
       * Add a constraint for finding string values that end with a provided
       * string.  This will be slow for large datasets.
       * @param {String} key The key that the string to match is stored in.
       * @param {String} suffix The substring that the value must end with.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      endsWith: function(key, value) {
        this._addCondition(key, '$regex', this._quote(value) + '$');
        return this;
      },

      /**
       * Sorts the results in ascending order by the given key.
       *
       * @param {String} key The key to order by.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      ascending: function(key) {
        requires(key, 'undefined is not a valid key');
        this._order = key;
        return this;
      },

      /**
       * Also sorts the results in ascending order by the given key. The previous sort keys have
       * precedence over this key.
       *
       * @param {String} key The key to order by
       * @return {AV.Query} Returns the query so you can chain this call.
       */
      addAscending: function(key) {
        requires(key, 'undefined is not a valid key');
        if (this._order) this._order += ',' + key;
        else this._order = key;
        return this;
      },

      /**
       * Sorts the results in descending order by the given key.
       *
       * @param {String} key The key to order by.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      descending: function(key) {
        requires(key, 'undefined is not a valid key');
        this._order = '-' + key;
        return this;
      },

      /**
       * Also sorts the results in descending order by the given key. The previous sort keys have
       * precedence over this key.
       *
       * @param {String} key The key to order by
       * @return {AV.Query} Returns the query so you can chain this call.
       */
      addDescending: function(key) {
        requires(key, 'undefined is not a valid key');
        if (this._order) this._order += ',-' + key;
        else this._order = '-' + key;
        return this;
      },

      /**
       * Add a proximity based constraint for finding objects with key point
       * values near the point given.
       * @param {String} key The key that the AV.GeoPoint is stored in.
       * @param {AV.GeoPoint} point The reference AV.GeoPoint that is used.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      near: function(key, point) {
        if (!(point instanceof AV.GeoPoint)) {
          // Try to cast it to a GeoPoint, so that near("loc", [20,30]) works.
          point = new AV.GeoPoint(point);
        }
        this._addCondition(key, '$nearSphere', point);
        return this;
      },

      /**
       * Add a proximity based constraint for finding objects with key point
       * values near the point given and within the maximum distance given.
       * @param {String} key The key that the AV.GeoPoint is stored in.
       * @param {AV.GeoPoint} point The reference AV.GeoPoint that is used.
       * @param maxDistance Maximum distance (in radians) of results to return.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      withinRadians: function(key, point, distance) {
        this.near(key, point);
        this._addCondition(key, '$maxDistance', distance);
        return this;
      },

      /**
       * Add a proximity based constraint for finding objects with key point
       * values near the point given and within the maximum distance given.
       * Radius of earth used is 3958.8 miles.
       * @param {String} key The key that the AV.GeoPoint is stored in.
       * @param {AV.GeoPoint} point The reference AV.GeoPoint that is used.
       * @param {Number} maxDistance Maximum distance (in miles) of results to
       *     return.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      withinMiles: function(key, point, distance) {
        return this.withinRadians(key, point, distance / 3958.8);
      },

      /**
       * Add a proximity based constraint for finding objects with key point
       * values near the point given and within the maximum distance given.
       * Radius of earth used is 6371.0 kilometers.
       * @param {String} key The key that the AV.GeoPoint is stored in.
       * @param {AV.GeoPoint} point The reference AV.GeoPoint that is used.
       * @param {Number} maxDistance Maximum distance (in kilometers) of results
       *     to return.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      withinKilometers: function(key, point, distance) {
        return this.withinRadians(key, point, distance / 6371.0);
      },

      /**
       * Add a constraint to the query that requires a particular key's
       * coordinates be contained within a given rectangular geographic bounding
       * box.
       * @param {String} key The key to be constrained.
       * @param {AV.GeoPoint} southwest
       *     The lower-left inclusive corner of the box.
       * @param {AV.GeoPoint} northeast
       *     The upper-right inclusive corner of the box.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      withinGeoBox: function(key, southwest, northeast) {
        if (!(southwest instanceof AV.GeoPoint)) {
          southwest = new AV.GeoPoint(southwest);
        }
        if (!(northeast instanceof AV.GeoPoint)) {
          northeast = new AV.GeoPoint(northeast);
        }
        this._addCondition(key, '$within', { $box: [southwest, northeast] });
        return this;
      },

      /**
       * Include nested AV.Objects for the provided key.  You can use dot
       * notation to specify which fields in the included object are also fetch.
       * @param {String[]} keys The name of the key to include.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      include: function(keys) {
        requires(keys, 'undefined is not a valid key');
        _(arguments).forEach(keys => {
          this._include = this._include.concat(ensureArray(keys));
        });
        return this;
      },

      /**
       * Include the ACL.
       * @param {Boolean} [value=true] Whether to include the ACL
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      includeACL: function(value = true) {
        this._includeACL = value;
        return this;
      },

      /**
       * Restrict the fields of the returned AV.Objects to include only the
       * provided keys.  If this is called multiple times, then all of the keys
       * specified in each of the calls will be included.
       * @param {String[]} keys The names of the keys to include.
       * @return {AV.Query} Returns the query, so you can chain this call.
       */
      select: function(keys) {
        requires(keys, 'undefined is not a valid key');
        _(arguments).forEach(keys => {
          this._select = this._select.concat(ensureArray(keys));
        });
        return this;
      },

      /**
       * Iterates over each result of a query, calling a callback for each one. If
       * the callback returns a promise, the iteration will not continue until
       * that promise has been fulfilled. If the callback returns a rejected
       * promise, then iteration will stop with that error. The items are
       * processed in an unspecified order. The query may not have any sort order,
       * and may not use limit or skip.
       * @param callback {Function} Callback that will be called with each result
       *     of the query.
       * @return {Promise} A promise that will be fulfilled once the
       *     iteration has completed.
       */
      each: function(callback, options = {}) {
        if (this._order || this._skip || this._limit >= 0) {
          var error = new Error(
            'Cannot iterate on a query with sort, skip, or limit.'
          );
          return Promise.reject(error);
        }

        var query = new AV.Query(this.objectClass);
        // We can override the batch size from the options.
        // This is undocumented, but useful for testing.
        query._limit = options.batchSize || 100;
        query._where = _.clone(this._where);
        query._include = _.clone(this._include);

        query.ascending('objectId');

        var finished = false;
        return Promise._continueWhile(
          function() {
            return !finished;
          },
          function() {
            return query.find(options).then(function(results) {
              var callbacksDone = Promise.resolve();
              _.each(results, function(result) {
                callbacksDone = callbacksDone.then(function() {
                  return callback(result);
                });
              });

              return callbacksDone.then(function() {
                if (results.length >= query._limit) {
                  query.greaterThan('objectId', results[results.length - 1].id);
                } else {
                  finished = true;
                }
              });
            });
          }
        );
      },

      /**
       * Subscribe the changes of this query.
       *
       * LiveQuery is not included in the default bundle: {@link https://url.leanapp.cn/enable-live-query}.
       *
       * @since 3.0.0
       * @return {AV.LiveQuery} An eventemitter which can be used to get LiveQuery updates;
       */
      subscribe(options) {
        return AV.LiveQuery.init(this, options);
      },
    }
  );

  AV.FriendShipQuery = AV.Query._extend({
    _newObject: function() {
      const UserClass = AV.Object._getSubclass('_User');
      return new UserClass();
    },
    _processResult: function(json) {
      if (json && json[this._friendshipTag]) {
        var user = json[this._friendshipTag];
        if (user.__type === 'Pointer' && user.className === '_User') {
          delete user.__type;
          delete user.className;
        }
        return user;
      } else {
        return null;
      }
    },
  });
};
