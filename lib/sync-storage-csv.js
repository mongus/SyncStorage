'use strict';

// CSV functions for internal use
(typeof(window) === 'object' ? window.SyncStorage : exports).SyncStorageCsv = function() {
    var closeCell = function(buffer) {
        if (buffer.length == 0)
            return null;
        else if (buffer.charAt(0) == "'")
            return buffer.substring(1, buffer.length - 1);
        else if (buffer.substring(buffer.length - 2) === 'ms')
            return new Date(Number(buffer.substring(0, buffer.length - 2)));
        else
            return Number(buffer);
    };

    this.parse = function(csv, onHeader, onRow) {
        var pk = 0;

        var fields = null;
        var p = 0, l = csv.length;

        var row = [];
        var buffer = '';
        var quoted = false;
        var c;

        if (typeof(onRow) !== 'function')
            onRow = null;

        do {
            c = csv.charAt(p++);

            if (!quoted) {
                switch (c) {
                    case ',':
                        row.push(closeCell(buffer));
                        buffer = '';
                        break;
                    case '\n':
                        row.push(closeCell(buffer));
                        buffer = '';

                        if (!fields) {
                            fields = row;

                            if (typeof(onHeader) == 'function')
                                onHeader(fields);
                        }
                        else if (onRow)
                            onRow(row);

                        row = [];
                        break;
                    case "'":
                        quoted = true;
                        buffer += c;
                        break;
                    default:
                        buffer += c;
                }
            }
            else {
                buffer += c;

                if (c === "'") {
                    if (p < l && csv.charAt(p) === "'") {
                        // found an escaped quote so skip the next char
                        p++;
                    }
                    else {
                        quoted = false;
                    }
                }
            }
        } while (p < l);

        if (buffer.length > 0 || row.length > 0) {
            row.push(closeCell(buffer));
            if (fields && onRow)
                onRow(row);
        }
    };


    var ouput = '', fields = null;

    var formatCell = function(value) {
        if (value === null)
            return '';

        if (typeof(value) === 'string')
            return "'" + value.replace(/'/g, "''") + "'";
        else if (value instanceof Date)
            return value.getTime() + 'ms';

        return '' + value;
    };

    this.addHeader = function(fields) {
        this.fields = fields;

        this.output = '';

        var first = true;

        for (var i = 0, c = fields.length; i < c; i++) {
            if (first)
                first = false;
            else
                this.output += ',';

            this.output += formatCell(fields[i]);
        }
    };

    this.addRow = function(object) {
        this.output += '\n';

        var first = true;

        for (var i = 0, c = this.fields.length; i < c; i++) {
            if (first)
                first = false;
            else
                this.output += ',';

            this.output += formatCell(object[this.fields[i]]);
        }
    };

    this.getCsv = function() {
        return this.output;
    }

    this.format = function(map, fields) {
        var keys = Object.keys(map);

        if (!keys.length)
            return '';

        if (!fields)
            fields = Object.keys(map[keys[0]]);

        var csv = this.addHeader(fields);

        for (var i = 0, l = keys.length; i < l; i++)
            csv += this.addRow(map[keys[i]]);

        return this.getCsv();
    };
};
