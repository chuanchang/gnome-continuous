#!/usr/bin/python
#
# Copyright (C) 2011 Colin Walters <walters@verbum.org>
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the
# Free Software Foundation, Inc., 59 Temple Place - Suite 330,
# Boston, MA 02111-1307, USA.

import os
import sys
import argparse

from . import builtins

JS_BUILTINS = {'autobuilder': "Run resolve and build",
               'checkout': "Check out source tree",
               'prefix': "Display or modify \"prefix\" (build target)",
               'git-mirror': "Update internal git mirror for one or more components",
               'resolve': "Expand git revisions in source to exact targets",
               'build': "Build multiple components and generate trees"};

def usage(ecode):
    print "Builtins:"
    for builtin in builtins.get_all():
        if builtin.name.startswith('privhelper'):
            continue
        print "    %s - %s" % (builtin.name, builtin.short_description)
    for name,short_description in JS_BUILTINS.items():
        print "    %s - %s" % (name, short_description)
    return ecode

def main(args):
    if len(args) < 1:
        return usage(1)
    elif args[0] in ('-h', '--help'):
        return usage(0)
    else:
        name = args[0]
        builtin = builtins.get(name)
        if builtin is None:
            js_builtin = JS_BUILTINS.get(name)
            if js_builtin is None:
                print "error: Unknown builtin '%s'" % (args[0], )
                return usage(1)
            else:
                child_args = ['ostbuild-js', name.replace('-', '_')]
                child_args.extend(args[1:])
                os.execvp('ostbuild-js', child_args)
        return builtin.execute(args[1:])
    
    
