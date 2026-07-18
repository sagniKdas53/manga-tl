import xml.etree.ElementTree as ET

pom_file = 'backend/pom.xml'
tree = ET.parse(pom_file)
root = tree.getroot()
ns = {'mvn': 'http://maven.apache.org/POM/4.0.0'}

# Find maven-compiler-plugin
plugins = root.find('.//mvn:plugins', ns)
for plugin in plugins.findall('mvn:plugin', ns):
    artifactId = plugin.find('mvn:artifactId', ns)
    if artifactId is not None and artifactId.text == 'maven-compiler-plugin':
        configuration = plugin.find('mvn:configuration', ns)
        if configuration is None:
            configuration = ET.SubElement(plugin, 'configuration')
        
        compilerId = ET.SubElement(configuration, 'compilerId')
        compilerId.text = 'eclipse'
        
        showWarnings = configuration.find('mvn:showWarnings', ns)
        if showWarnings is None:
            showWarnings = ET.SubElement(configuration, 'showWarnings')
        showWarnings.text = 'true'
        
        compilerArgs = configuration.find('mvn:compilerArgs', ns)
        if compilerArgs is None:
            compilerArgs = ET.SubElement(configuration, 'compilerArgs')
        arg = ET.SubElement(compilerArgs, 'arg')
        arg.text = '-err:+null'
        
        # Add plexus-compiler-eclipse dependency to the plugin
        dependencies = plugin.find('mvn:dependencies', ns)
        if dependencies is None:
            dependencies = ET.SubElement(plugin, 'dependencies')
        
        dep = ET.SubElement(dependencies, 'dependency')
        gId = ET.SubElement(dep, 'groupId')
        gId.text = 'org.codehaus.plexus'
        aId = ET.SubElement(dep, 'artifactId')
        aId.text = 'plexus-compiler-eclipse'
        vId = ET.SubElement(dep, 'version')
        vId.text = '2.13.0'

tree.write('backend/pom_ecj.xml', default_namespace='http://maven.apache.org/POM/4.0.0')
